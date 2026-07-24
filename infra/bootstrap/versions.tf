terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }

  # bootstrap 的 state 刻意留在本機：它極少變動，且由使用者本機以 owner 權限跑一次。
  # 這裡「不」用 GCS backend——因為這份 config 正是負責建出那個 state bucket，
  # 拿還沒存在的 bucket 當 backend 會雞生蛋。App 那份（infra/）才用 GCS backend。
}

provider "google" {
  project = var.project_id
  region  = var.region
}
