terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }

  # state 存在 GCS（由 infra/bootstrap 建立的 bucket），讓本機與 GitHub Actions
  # CI 共用同一份 state。bucket 名寫死在此：backend 區塊不接受變數；fork 者請改這裡
  # 或用 `terraform init -backend-config=...` 覆寫。
  # 設計上不讓任何機密進 state：API key 由 UI 寫入 bucket 上的 models.json，
  # IAP 的 OAuth 設定不由 Terraform 管理。
  backend "gcs" {
    bucket = "slide-maker-503201-tfstate"
    prefix = "slide-maker/app"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
