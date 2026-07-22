variable "project_id" {
  type        = string
  description = "GCP 專案 ID。"
}

variable "region" {
  type        = string
  description = "Cloud Run 與 bucket 的區域，兩者必須相同。"
  default     = "asia-east1"
}

variable "service_name" {
  type        = string
  description = "Cloud Run service 名稱。"
  default     = "slide-maker"
}

variable "bucket_name" {
  type        = string
  description = "資料 bucket 名稱（全域唯一）。掛載成容器內的 /data。"
}

variable "repository_id" {
  type        = string
  description = "Artifact Registry 儲存庫名稱。"
  default     = "slide-maker"
}

variable "trusted_hosts" {
  type        = list(string)
  default     = []
  description = <<-EOT
    除了 localhost 之外，還要放行的主機名（app.ts 的主機閘門）。留空時 API 會對
    每一個外部請求回 403——這是刻意的預設。填入 Cloud Run 的主機名之後，這道防線
    就交給前面的 IAP 了，所以 IAP 沒設好之前不要填。

    主機名在第一次建立 service 之前不會知道：先用空值 apply，再把 service_url 的
    主機名填進來 apply 第二次。
  EOT
}

variable "image" {
  type        = string
  description = <<-EOT
    要部署的完整映像位址，例如
    asia-east1-docker.pkg.dev/<專案>/slide-maker/server:2026-07-22。
    映像由本機 docker buildx 建置並推送，不由 Terraform 建置——
    請務必帶明確 tag 或 digest，不要用 latest，否則 Cloud Run 不會換 revision。
  EOT
}
