# Experiment summary

Quality = mean bitrate a client watched (1000 / 2500 / 5000 kbps = 360p / 540p / 720p).
Values are averaged per run first, then over runs; min-max and std show how
much the runs differ from each other. Servers = average clients per run.

## flash

| Mode | Runs | Quality (kbps) | Min-max | Std | Startup (s) | Stalls / run | Clients stalled | Switches / client | Failed | srv1 / srv2 / srv3 / srv4 |
|---|---|---|---|---|---|---|---|---|---|---|
| hop | 5 | 1384 | 1348-1448 | 38 | 0.90 | 0.4 | 2 | 1.3 | 0 | 6.0 / 3.0 / 0.0 / 0.0 |
| load | 5 | 3333 | 3307-3351 | 17 | 0.43 | 0.2 | 1 | 2.2 | 0 | 2.8 / 2.2 / 2.0 / 2.0 |
| bw | 5 | 3660 | 3159-4233 | 491 | 0.47 | 0.0 | 0 | 3.9 | 0 | 0.0 / 0.0 / 1.2 / 7.8 |
| delay | 5 | 2024 | 1915-2122 | 87 | 0.53 | 1.2 | 6 | 3.1 | 0 | 0.0 / 3.0 / 6.0 / 0.0 |
| combo | 5 | 3176 | 3026-3540 | 208 | 0.39 | 0.6 | 3 | 3.1 | 0 | 1.8 / 2.8 / 3.2 / 1.2 |

## gradual

| Mode | Runs | Quality (kbps) | Min-max | Std | Startup (s) | Stalls / run | Clients stalled | Switches / client | Failed | srv1 / srv2 / srv3 / srv4 |
|---|---|---|---|---|---|---|---|---|---|---|
| hop | 5 | 2378 | 2207-2474 | 128 | 0.66 | 0.4 | 2 | 3.3 | 0 | 6.0 / 3.0 / 0.0 / 0.0 |
| load | 5 | 4228 | 4133-4340 | 81 | 0.40 | 0.0 | 0 | 2.5 | 0 | 3.0 / 2.0 / 2.0 / 2.0 |
| bw | 5 | 4439 | 4344-4566 | 94 | 0.44 | 0.0 | 0 | 2.6 | 0 | 0.0 / 0.0 / 1.4 / 7.6 |
| delay | 5 | 3791 | 3459-4118 | 264 | 0.41 | 0.4 | 2 | 2.8 | 0 | 1.8 / 3.2 / 3.6 / 0.4 |
| combo | 5 | 4581 | 4437-4640 | 84 | 0.30 | 0.0 | 0 | 1.8 | 0 | 1.2 / 2.0 / 2.8 / 3.0 |
