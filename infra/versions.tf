terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }

  # state 刻意留在本機（見 README「雲端部署」）。terraform.tfstate 已進 .gitignore。
  # 設計上不讓任何機密進 state：API key 由 UI 寫入 bucket 上的 models.json，
  # IAP 的 OAuth 設定不由 Terraform 管理。
}

provider "google" {
  project = var.project_id
  region  = var.region
}
