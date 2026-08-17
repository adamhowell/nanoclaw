---
name: mycobot
description: Control the MyCobot 280 robot arm (with overhead camera) — move it, see the workspace, and visually servo the gripper to any point. Use when the user asks the agent to move/drive the arm, pick or point at something, or look at the robot's camera.
---

# MyCobot 280 arm control

A MyCobot 280 Pi robot arm is bolted to a plywood board under a fixed overhead camera. You
drive it over HTTP. **Everything is closed-loop on the camera** — you don't compute
kinematics; you ask the arm to put its gripper at a pixel and it visually servos there.

## ⚠️ There is an engraving laser in the workspace

An OMTech fiber laser sits on the same board, occupying the upper part of the camera frame.
Two rules that follow from it:

- **Retract before rotating toward the laser.** The laser head is only ~190mm from the arm
  base, and the arm reaches 289mm. Swinging the base while extended drives the claw straight
  into the machine. Fold in first (reduce the radius), rotate, then extend.
- **Never assume it is safe to fire.** The bed is open, there is no enclosure, and the beam
  is invisible. Firing is not wired up yet; when it is, the arm must be verified parked and
  clear on camera first.

## How to call it

```
BASE = http://host.docker.internal:8089      # bridge on Burnie host -> robot Pi control server
```

| Call | What it does |
|---|---|
| `GET  {BASE}/health` | liveness check → `{"ok":true}` |
| `GET  {BASE}/snapshot` | current camera frame (JPEG, 1920×1080) — look here first |
| `GET  {BASE}/angles` | `{"angles":[6], "coords":[x,y,z,rx,ry,rz]}` current pose |
| `GET  {BASE}/localize` | `{"gripper_px":[u,v], "method":"marker"\|"wiggle"}` where the gripper is |
| `GET  {BASE}/markers` | every visible ArUco tag → `{id: {center:[u,v], side_px}}` |
| `POST {BASE}/goto` `{"tx":U,"ty":V,"ready":false}` | **closed-loop: drive the gripper to pixel (U,V)** |
| `POST {BASE}/angles` `{"angles":[6],"speed":30}` | set joint angles directly (validated to limits) |
| `POST {BASE}/gripper` `{"value":0..100}` | gripper: 0=closed, 100=open |
| `POST {BASE}/recover` | clear an over-limit fault + power on (call if moves stop working) |

## ⚠️ Do NOT call `POST /ready`

The stored READY pose predates the current mount. It swings the arm off the back of the
board over the desk. **Always pass `{"ready": false}` to `/goto`**, and move to a known-good
pose with `POST /angles` instead.

## Typical task: "move the gripper to <thing>"

1. `GET /snapshot`, find the target's pixel (u,v) in the image.
2. Make sure the arm is not extended toward the laser (see above); retract with
   `POST /angles` if it is.
3. `POST /goto {tx:u, ty:v, ready:false}` → check `error_px` (<20 px ≈ 1cm is good).
4. To grab: `POST /gripper {value:0}` to close, `{value:100}` to open.

## Key facts / gotchas (learned the hard way)

- **Localization is ArUco-first.** The gripper carries tags on its faces (ids 10-14, one per
  face). `/localize` returns whichever face is visible — single frame, sub-pixel repeatable,
  no motion. `"method":"marker"` means you got that. It falls back to `"wiggle"` (an
  open/close frame-diff) when no face is showing, and **the wiggle result is imprecise —
  treat it as a rough region, not a position.**
- **The top face tag (id 10) points at the camera** whenever the claw is upright or coming
  down onto a surface, which is most working poses.
- **Camera exposure is pinned** (`exposure_auto=1`, `exposure_absolute=1200`) by
  `/usr/local/bin/mycobot-camsetup.sh`, run as an `ExecStartPre` of `robot-server.service`.
  Auto-exposure blows out the white gripper and destroys tag detection — if markers stop
  being found, check this first.
- **Cartesian moves are unreliable on this arm** — that's why we servo on the camera instead
  of sending xyz. `send_coords` silently no-ops or drifts from folded poses.
- **Reachable region is an annulus**, not the whole frame. Max reach ~289mm.
- If commands silently do nothing, the arm likely hit an **over-limit fault** →
  `POST /recover`. The arm droops past J2's limit under gravity when servos are released.

## Geometry (camera position of 2026-08-17 — re-measure if the camera moves)

- Base (J1 rotation center) projects to pixel ≈ **(880, 755)**.
- **image-angle (y-up, measured about the base pixel) ≈ J1 + 51°**.
- Scale ≈ **2.7 px/mm** near board level.
- Laser head sits at image-angle ≈ 116° (**J1 ≈ 65**), ~190mm out from the base.

These numbers die whenever the camera is moved, and it has moved three times. Re-derive
before trusting them: read `/angles` for the arm's own `coords` radius, `/localize` for the
pixel, and fit.

## Troubleshooting

- `/health` unreachable → the **robot-bridge** on Burnie (`com.hwm.robot-bridge`, port 8089)
  and/or the **control server** on the robot Pi (`robot_server.py`, port 8088) isn't running.
- Robot Pi is on Tailscale as **`mycobot-pi` = 100.123.108.124**; the bridge targets that.
  SSH as `er@mycobot-pi` (the raw Tailscale IP fails host-key verification).
- Service: `sudo systemctl restart robot-server.service` on the Pi.
