locals {
  services = [
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "storage.googleapis.com",
    "cloudresourcemanager.googleapis.com",
  ]

  # deployer SA 跑 App infra（infra/）的 terraform apply 所需角色。範圍刻意收在
  # 「App config 會碰到的資源」：Cloud Run、資料 bucket＋state bucket、Artifact
  # Registry repo、建立 runtime SA、啟用 API、以 runtime SA 身分部署。
  # 刻意「不」給 project IAM admin——deployer 不該能改自己的權限。
  deploy_roles = [
    "roles/run.admin",                      # 管理 Cloud Run service
    "roles/storage.admin",                  # 資料 bucket + state bucket（含 bucket IAM）
    "roles/artifactregistry.admin",         # 推映像 + 管理 repo 資源
    "roles/iam.serviceAccountAdmin",        # main.tf 建立 runtime SA
    "roles/iam.serviceAccountUser",         # 部署 Cloud Run「以 runtime SA 身分執行」
    "roles/serviceusage.serviceUsageAdmin", # main.tf 的 google_project_service 啟用 API
  ]
}

resource "google_project_service" "enabled" {
  for_each = toset(local.services)

  service            = each.value
  disable_on_destroy = false
}

########################################
# Terraform state bucket（給 infra/ 當 GCS backend）
########################################
resource "google_storage_bucket" "tfstate" {
  name          = var.state_bucket_name
  location      = var.region
  storage_class = "STANDARD"

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # state 要版本控制：誤 apply 或本機/CI 撞車時可回溯。這是普通 flat bucket
  # （非 HNS），允許 versioning。
  versioning {
    enabled = true
  }

  depends_on = [google_project_service.enabled]
}

########################################
# Workload Identity Federation：GitHub Actions → GCP（免長期金鑰）
########################################
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github-pool"
  display_name              = "GitHub Actions"
  description               = "OIDC pool for GitHub Actions deploys"

  depends_on = [google_project_service.enabled]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-provider"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  # 只放行本 repo。GitHub OIDC 的 provider 若不加 condition，attribute.repository
  # 會被任何 repo 帶進來——等於全世界都能換到這個 SA 的權杖。
  attribute_condition = "assertion.repository == '${var.github_repository}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

########################################
# Deployer service account
########################################
resource "google_service_account" "deploy" {
  account_id   = "slide-maker-deploy"
  display_name = "slide-maker GitHub Actions deployer"
}

resource "google_project_iam_member" "deploy" {
  for_each = toset(local.deploy_roles)

  project = var.project_id
  role    = each.value
  member  = google_service_account.deploy.member
}

# 只有「本 repo 的 workflow」能扮演 deployer SA。principalSet 用 attribute.repository
# 綁定，配合上面 provider 的 attribute_condition 形成雙重限制。
resource "google_service_account_iam_member" "wif_binding" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}
