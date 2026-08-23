#!/usr/bin/env ruby
# IPC-driven iMessage sender. Watches ~/nanoclaw/data/imessage_outbox
# for *.json files of the form:
#   { "to": "adamhowell@gmail.com", "body": "..." }
#   { "to": "adamhowell@gmail.com", "body": "...", "attachment": "/absolute/path/to/image.png" }
# Sends each via Messages.app (participant form, which is the only
# AppleScript path that works on macOS 26+) and moves the file into
# imessage_sent on success. On failure, leaves the file in place and
# logs the error so a future run can retry.

require "json"
require "fileutils"
require "open3"
require "time"
require "timeout"

# osascript can block indefinitely: a modal dialog in Messages, or anything
# that drags in xcrun and lands on an unaccepted Xcode licence. This script is
# one-shot and launchd will not start a second instance while one is alive, so
# a single hung send silently stops every message from then on. That is exactly
# what happened on 2026-08-05 — six days of outage with nothing in the log,
# because the process never reached a line that logs.
SEND_TIMEOUT = 60

# A crash between claiming a file and finishing with it leaves a .claimed-<pid>
# behind. It no longer matches the *.json glob, so the message becomes
# invisible and is never retried. One from 2026-06-06 sat unnoticed for two
# months.
CLAIM_STALE_AFTER = 900

HOME    = ENV["HOME"] || Dir.home
OUTBOX  = File.join(HOME, "nanoclaw/data/imessage_outbox")
SENT    = File.join(HOME, "nanoclaw/data/imessage_sent")
LOG     = File.join(HOME, "nanoclaw/logs/imessage_dispatch.log")

FileUtils.mkdir_p([ OUTBOX, SENT, File.dirname(LOG) ])

def log(msg)
  File.open(LOG, "a") { |f| f.puts("#{Time.now.iso8601} #{msg}") }
end

def send_imessage(to, body)
  # AppleScript heredoc with the body interpolated as a quoted Ruby
  # string — escape backslashes + double quotes so multi-line bodies
  # don't break the script.
  safe_body = body.to_s.gsub("\\", "\\\\").gsub('"', '\\"')
  safe_to   = to.to_s.gsub('"', '\\"')
  script = <<~APPLESCRIPT
    tell application "Messages"
      set targetService to 1st service whose service type is iMessage
      set targetBuddy to participant "#{safe_to}" of targetService
      send "#{safe_body}" to targetBuddy
    end tell
  APPLESCRIPT
  out, err, status = capture_with_timeout(script)
  return false if status.nil?

  unless status.success?
    log("[error] osascript failed for #{to}: #{err.strip}")
    return false
  end
  true
end

# Returns [out, err, status]; status is nil when the call had to be killed.
def capture_with_timeout(script)
  Timeout.timeout(SEND_TIMEOUT) do
    Open3.capture3("osascript", "-e", script)
  end
rescue Timeout::Error
  # Reap the straggler, or the next run inherits the same wedge.
  system("pkill", "-9", "-x", "osascript", out: File::NULL, err: File::NULL)
  log("[error] osascript exceeded #{SEND_TIMEOUT}s and was killed. Check Messages.app for a modal dialog, and `git --version` for an xcrun/Xcode-licence hang.")
  [ nil, nil, nil ]
end

def send_imessage_attachment(to, attachment_path)
  # Sends a file (image, etc.) as an iMessage attachment.
  # attachment_path must be an absolute POSIX path on the host.
  unless File.exist?(attachment_path)
    log("[error] attachment not found: #{attachment_path}")
    return false
  end
  safe_path = attachment_path.to_s.gsub("\\", "\\\\").gsub('"', '\\"')
  safe_to   = to.to_s.gsub('"', '\\"')
  script = <<~APPLESCRIPT
    tell application "Messages"
      set targetService to 1st service whose service type is iMessage
      set targetBuddy to participant "#{safe_to}" of targetService
      send POSIX file "#{safe_path}" to targetBuddy
    end tell
  APPLESCRIPT
  out, err, status = capture_with_timeout(script)
  return false if status.nil?

  unless status.success?
    log("[error] osascript attachment failed for #{to}: #{err.strip}")
    return false
  end
  true
end

# Recover anything a dead run left claimed. A claim whose owning pid is gone,
# or that is simply older than any plausible send, belongs back in the queue.
Dir.glob(File.join(OUTBOX, "*.json.claimed-*")).each do |orphan|
  begin
    pid = orphan[/\.claimed-(\d+)\z/, 1].to_i
    owner_alive =
      begin
        pid.positive? && Process.kill(0, pid) && true
      rescue Errno::ESRCH
        false
      rescue Errno::EPERM
        true
      end
    next if owner_alive && (Time.now - File.mtime(orphan)) < CLAIM_STALE_AFTER

    restored = orphan.sub(/\.claimed-\d+\z/, "")
    File.rename(orphan, restored)
    log("[recovered] #{File.basename(restored)} was claimed by dead pid #{pid} - requeued")
  rescue => e
    log("[error] could not recover #{File.basename(orphan)}: #{e.class}: #{e.message}")
  end
end

Dir.glob(File.join(OUTBOX, "*.json")).sort.each do |path|
  # Concurrency-safe claim: rename into a working slot under the
  # outbox directory before reading. If another launchd tick has
  # already grabbed this file, the rename will raise ENOENT and we
  # just move on. Single atomic op on local FS — no lockfile needed.
  claimed = "#{path}.claimed-#{Process.pid}"
  begin
    File.rename(path, claimed)
  rescue Errno::ENOENT
    next
  end

  begin
    payload = JSON.parse(File.read(claimed)) rescue nil
    unless payload.is_a?(Hash) && payload["to"] && payload["body"]
      log("[skip] bad payload at #{claimed}")
      next
    end

    success = true

    # Send attachment first (if present), then the text body.
    if payload["attachment"]
      success = send_imessage_attachment(payload["to"], payload["attachment"])
      # Small pause so the image lands before the text bubble.
      sleep(1) if success
    end

    success &&= send_imessage(payload["to"], payload["body"]) if success

    if success
      FileUtils.mv(claimed, File.join(SENT, File.basename(path)))
      log("[ok] sent #{File.basename(path)} → #{payload['to']}")
    else
      # Restore so a future run can retry.
      File.rename(claimed, path)
      log("[fail] kept #{File.basename(path)} for retry")
    end
  rescue => e
    File.rename(claimed, path) if File.exist?(claimed)
    log("[error] #{File.basename(path)}: #{e.class}: #{e.message}")
  end
end
