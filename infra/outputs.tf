output "service_url" {
  description = "Cloud Run 主網址。IAP 設好之前，未授權的請求一律 403。"
  value       = google_cloud_run_v2_service.app.uri
}

output "service_urls" {
  description = <<-EOT
    Cloud Run 配給這個服務的「全部」網址——通常有兩個（新的
    <服務>-<專案編號>.<區域>.run.app 與舊的 <服務>-<雜湊>-<區碼>.a.run.app）。
    var.trusted_hosts 要把兩個主機名都列進去，否則從沒列到的那個進來會被
    app.ts 的閘門擋成 LOCAL_HOST_REQUIRED。gcloud run services describe 的
    status.url 只會顯示其中一個，不可當作完整清單。
  EOT
  value       = google_cloud_run_v2_service.app.urls
}

output "bucket_name" {
  description = "資料 bucket，掛載成容器內的 /data。"
  value       = google_storage_bucket.data.name
}

output "runtime_service_account" {
  description = "Cloud Run 的執行身分。"
  value       = google_service_account.run.email
}

output "image_repository" {
  description = "推送映像的目標位址前綴。"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.docker.repository_id}"
}
