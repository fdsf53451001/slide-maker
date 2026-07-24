output "wif_provider" {
  description = <<-EOT
    完整的 WIF provider 資源名，填進 GitHub repo variable WIF_PROVIDER，
    給 google-github-actions/auth 的 workload_identity_provider 用。
  EOT
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "deploy_sa_email" {
  description = "deployer SA email，填進 GitHub repo variable DEPLOY_SA。"
  value       = google_service_account.deploy.email
}

output "state_bucket" {
  description = "App infra（infra/）的 GCS backend bucket 名。"
  value       = google_storage_bucket.tfstate.name
}
