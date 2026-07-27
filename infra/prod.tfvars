# CI（.github/workflows/deploy.yml）與手動 apply 共用的正式環境變數。
# 全部非機密——API key 不在此，由 UI 寫進 bucket 上的 models.json。
# image 不放這裡：CI 以 -var="image=..." 帶入當次 commit 的映像。
project_id  = "slide-maker-503201"
region      = "asia-east1"
bucket_name = "slide-maker-503201-data"

# app.ts 的主機閘門白名單。Cloud Run 會配兩個主機名，兩個都要列，否則沒列到的
# 那個會被擋成 LOCAL_HOST_REQUIRED（見 docs/DEPLOYMENT.md）。自訂網域同理——
# 前面擺了 IAP 之後，指過來的網域也必須自己列一行，不支援萬用字元。
trusted_hosts = [
  "slide-maker-941757070298.asia-east1.run.app",
  "slide-maker-mnqpnlvqea-de.a.run.app",
  "slide.tobyeider.net",
]
