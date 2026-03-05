#!/bin/bash

# =========================
# MacBook 合盖保持运行脚本
# =========================

# 1. 保持 Mac 接电源不睡眠
echo "[INFO] 设置接电源时系统不睡眠..."
sudo pmset -c sleep 0
sudo pmset -c tcpkeepalive 1  # 保持网络唤醒
sudo pmset -c disksleep 0     # 硬盘不睡眠
sudo pmset -c displaysleep 10 # 显示器可睡眠10分钟

# 2. 启动关键进程并保持唤醒
echo "[INFO] 启动进程并保持唤醒..."
caffeinate -dimsu bash -c "cd taskboard-electron && npm start"