variable "project_id" {
  type        = string
  description = "GCP 專案 ID。"
}

variable "region" {
  type        = string
  description = "資源區域，與 App infra 保持一致。"
  default     = "asia-east1"
}

variable "github_repository" {
  type        = string
  description = <<-EOT
    允許透過 WIF 換取權杖的 GitHub repo，格式 owner/repo。這是 OIDC provider 的
    attribute condition——少了它，任何 GitHub repo 都能拿 token 冒用這個 deployer SA。
  EOT
}

variable "state_bucket_name" {
  type        = string
  description = <<-EOT
    給 App infra（infra/）當 Terraform GCS backend 的 bucket 名（全域唯一）。
    這份 bootstrap config 負責建它，App config 的 backend 再指向它。
  EOT
}
