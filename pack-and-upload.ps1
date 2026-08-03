# ==============================================================
# ML Product Finder — 本机打包 & 上传到 Oracle VM
# 用法（PowerShell 在本机执行）：
#   .\pack-and-upload.ps1
#
# 前置：Oracle VM 已创建，IP 已知，SSH key 已配置
# ==============================================================

param(
    [string]$VM_IP = "",
    [string]$Upload = ""
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host ""
Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  ML Product Finder — 本机打包上传到 Oracle   ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ---- 1. 收集信息 ----
if ($VM_IP -eq "") {
    $VM_IP = Read-Host "  Oracle VM 公网 IP（如 129.153.x.x）"
}
if ($VM_IP -eq "") {
    Write-Host "错误: 必须提供 VM IP" -ForegroundColor Red
    exit 1
}

if ($Upload -eq "") {
    $Upload = Read-Host "  打包后自动上传？(y/N)"
}

# ---- 2. 打包 ----
$ArchiveName = "ml-finder.tar.gz"
$ArchivePath = "$PSScriptRoot\..\$ArchiveName"

Write-Host ""
Write-Host "  ⏳ 打包中..." -ForegroundColor Yellow

# 删除旧的
if (Test-Path $ArchivePath) { Remove-Item $ArchivePath -Force }

# 使用 tar 打包
tar -czf $ArchivePath `
    --exclude=node_modules `
    --exclude=release `
    --exclude=release-out `
    --exclude=.git `
    --exclude=dist `
    --exclude=dist-server `
    --exclude=dist-electron `
    --exclude=dist_bak_* `
    --exclude=_stale_bak `
    --exclude=pkg-staging `
    --exclude=data `
    --exclude='*.log' `
    --exclude='*.tar.gz' `
    --exclude='*.exe' `
    --exclude='cj.txt' `
    --exclude='remove_mode2.py' `
    --exclude='vite-log.txt' `
    --exclude='server-log.txt' `
    --exclude='*-err.log' `
    -C $PSScriptRoot .

$size = (Get-Item $ArchivePath).Length / 1MB
Write-Host "  ✅ 打包完成: $([math]::Round($size, 1)) MB" -ForegroundColor Green
Write-Host "     文件: $ArchivePath"
Write-Host ""

# ---- 3. 上传（可选） ----
if ($Upload -eq "y" -or $Upload -eq "Y") {
    Write-Host "  ⏳ 上传到 $VM_IP..." -ForegroundColor Yellow
    Write-Host ""

    # 上传打包文件
    scp $ArchivePath "ubuntu@${VM_IP}:~/"

    # 上传部署脚本
    scp "$PSScriptRoot\deploy-upload.sh" "ubuntu@${VM_IP}:~/"

    Write-Host ""
    Write-Host "  ✅ 上传完成！" -ForegroundColor Green
    Write-Host ""
    Write-Host "  接下来 SSH 到 VM 执行部署：" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "    ssh ubuntu@$VM_IP" -ForegroundColor White
    Write-Host "    chmod +x deploy-upload.sh" -ForegroundColor White
    Write-Host "    ./deploy-upload.sh" -ForegroundColor White
} else {
    Write-Host "  手动上传：" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "    scp $ArchivePath ubuntu@${VM_IP}:~/" -ForegroundColor White
    Write-Host "    scp deploy-upload.sh ubuntu@${VM_IP}:~/" -ForegroundColor White
    Write-Host ""
    Write-Host "  然后 SSH 到 VM 执行部署：" -ForegroundColor Cyan
    Write-Host "    ssh ubuntu@$VM_IP" -ForegroundColor White
    Write-Host "    chmod +x deploy-upload.sh && ./deploy-upload.sh" -ForegroundColor White
}
