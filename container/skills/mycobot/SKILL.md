---
name: mycobot
description: Control the MyCobot 280 robot arm (with overhead camera) — move it, see the workspace, and visually servo the gripper to any point on the board. Use when the user asks the agent to move/drive the arm, pick or point at something, or look at the robot's camera.
---

# MyCobot 280 arm control

A MyCobot 280 Pi robot arm sits on a matte board under a fixed overhead camera. You drive it
over HTTP. **Everything is closed-loop on the camera** — you don't compute kinematics; you ask
the arm to put its gripper at a pixel and it visually servos there.

## How to call it

All control is HTTP to the robot bridge (host service):

```
BASE = http://host.docker.internal:8089      # bridge on Burnie host -> robot Pi control server
```

(If that's unreachable, the bridge/robot server may be down — see Troubleshooting.)

| Call | What it does |
|---|---|
| `GET  {BASE}/health` | liveness check → `{"ok":true}` |
| `GET  {BASE}/snapshot` | current camera frame (JPEG, 1080p, top-down) — look here first |
| `GET  {BASE}/angles` | `{"angles":[6], "coords":[x,y,z,rx,ry,rz]}` current pose |
| `GET  {BASE}/localize` | `{"gripper_px":[u,v]}` where the gripper is in the image (works any orientation) |
| `POST {BASE}/ready` | move to a safe mid "ready" pose (always do this before navigating) |
| `POST {BASE}/goto` `{"tx":U,"ty":V}` | **closed-loop: drive the gripper to image pixel (U,V)**; returns `{ok,final_px,error_px}` |
| `POST {BASE}/angles` `{"angles":[6],"speed":30}` | set joint angles directly (validated to limits) |
| `POST {BASE}/gripper` `{"value":0..100}` | gripper: 0=closed, 100=open |
| `POST {BASE}/recover` | clear an over-limit fault + power on (call if moves stop working) |

## Typical task: "move the gripper to <thing>"

1. `GET /snapshot`, find the target's pixel (u,v) in the image (vision).
2. `POST /ready` (gives the arm joint room — skipping this is the #1 cause of failure).
3. `POST /goto {tx:u, ty:v}` → it visually servos there; check `error_px` (≈ <20 px ≈ ~1 cm is good).
4. To grab: `POST /gripper {value:0}` to close, `{value:100}` to open.

## Key facts / gotchas (learned the hard way)

- **Camera is fixed & top-down** over the board, framed by 4 ArUco corner tags (ids 1-4). Coordinates are image pixels (1920×1080).
- **Always `/ready` before `/goto`.** From a joint-limit pose the servo can't converge.
- **Reachable region is an annulus**, not the whole frame — points very close to the base or far past the arm's reach won't be hit; `/goto` returns the best `error_px` it achieved.
- **Cartesian moves are unreliable on this arm** — that's why we servo on the camera instead of sending xyz.
- If commands silently do nothing, the arm likely hit an **over-limit fault** → `POST /recover`.
- The gripper has ArUco tags (ids 10-14) on its faces; `/localize` uses an open/close-diff trick so it works regardless of orientation.

## Troubleshooting

- `/health` unreachable → the **robot-bridge** on Burnie (`com.hwm.robot-bridge`, port 8089) and/or the
  **control server** on the robot Pi (`er@192.168.1.212`, `robot_server.py`, port 8088) isn't running.
  Robot Pi reachable from Burnie host directly at `http://192.168.1.212:8088`.
