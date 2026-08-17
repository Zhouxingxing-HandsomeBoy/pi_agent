# Feishu 数字员工常驻启动脚本（测试工程师员工）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/feishu-worker.ps1
# 前置：SENSENOVA_API_KEY / FEISHU_APP_ID / FEISHU_APP_SECRET 已设为用户级环境变量
# 以 RPC 模式常驻运行（print 模式在初始消息后会 dispose session，扩展上下文失效）

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

Set-Location $repo

# 用户级环境变量自动继承；此处兜底提示
if (-not $env:FEISHU_APP_ID -or -not $env:FEISHU_APP_SECRET) {
    Write-Warning "FEISHU_APP_ID / FEISHU_APP_SECRET 未设置，feishu-bot 将自动禁用"
}
if (-not $env:SENSENOVA_API_KEY) {
    Write-Warning "SENSENOVA_API_KEY 未设置，模型调用将失败"
}

Write-Host "[feishu-worker] starting pi with feishu-bot (sensenova) ..."

node packages/coding-agent/dist/cli.js `
    --mode rpc `
    --model sensenova/sensenova-6.8-flash-lite `
    --approve
