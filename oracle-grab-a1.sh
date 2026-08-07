#!/usr/bin/env bash
# oracle-grab-a1.sh — 本地版：自动抢 Oracle Always Free A1.Flex（AD 轮换重试）
# 前置：本机已 `oci setup config` 配好凭证（~/.oci/config + key.pem）
# 用法：
#   COMP=ocid1.compartment... SUB=ocid1.subnet... IMG=ocid1.image... \
#   SSH_PUB="ssh-rsa AAAA..." bash oracle-grab-a1.sh
# 可选环境变量：OCPUS(默认2) MEMORY_GB(默认12) NAME(默认 ml-product-finder)
set -u

: "${COMP:?请设置 COMP（compartment OCID）}"
: "${SUB:?请设置 SUB（subnet OCID）}"
: "${IMG:?请设置 IMG（image OCID，需 aarch64）}"
: "${SSH_PUB:?请设置 SSH_PUB（SSH 公钥一行）}"

OCPUS=${OCPUS:-2}
MEMORY_GB=${MEMORY_GB:-12}
NAME=${NAME:-ml-product-finder}

# 查重：已有同名运行实例则跳过
EXIST=$(oci compute instance list --compartment-id "$COMP" \
  --lifecycle-state RUNNING --display-name "$NAME" \
  --query 'data[*].id' --raw-output 2>/dev/null)
if [ -n "$EXIST" ] && [ "$EXIST" != "[]" ]; then
  echo "✅ 实例已存在，跳过：$EXIST"
  exit 0
fi

# 列出本区域全部可用性域
ADS=$(oci iam availability-domain list --compartment-id "$COMP" \
  --query 'data[].name' --raw-output | tr -d '[]"' | tr ',' ' ')
echo "可用 AD: $ADS"

for i in $(seq 1 3000); do
  for AD in $ADS; do
    echo "[$(date +%H:%M:%S)] 第 $i 轮 尝试 $AD"
    OUT=$(oci compute instance launch \
      --availability-domain "$AD" \
      --shape VM.Standard.A1.Flex \
      --shape-config "{\"ocpus\":$OCPUS,\"memoryInGBs\":$MEMORY_GB}" \
      --image-id "$IMG" \
      --subnet-id "$SUB" \
      --assign-public-ip true \
      --display-name "$NAME" \
      --ssh-authorized-keys-file <(echo "$SSH_PUB") \
      --wait-for-state RUNNING 2>&1)
    if [ $? -eq 0 ]; then
      echo "✅ 成功创建于 $AD"
      echo "$OUT"
      exit 0
    fi
    if echo "$OUT" | grep -qi "capacity\|limit\|not available"; then
      echo "   ⚠️ 容量不足，换 AD / 重试"
    else
      echo "   ❌ 非容量错误，停止："
      echo "$OUT"
      exit 2
    fi
  done
  sleep 25
done
echo "未抢到"; exit 1
