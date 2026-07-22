locals {
  services = [
    "run.googleapis.com",
    "storage.googleapis.com",
    "artifactregistry.googleapis.com",
    "iap.googleapis.com",
    # 管理 IAP 存取授權（gcloud iap web get/set-iam-policy）要用到。
    "cloudresourcemanager.googleapis.com",
  ]
}

resource "google_project_service" "enabled" {
  for_each = toset(local.services)

  service = each.value
  # 關掉 API 會波及專案內其他資源，destroy 時保持啟用。
  disable_on_destroy = false
}

########################################
# Artifact Registry：映像由本機 buildx 推上來
########################################
resource "google_artifact_registry_repository" "docker" {
  location      = var.region
  repository_id = var.repository_id
  format        = "DOCKER"
  description   = "slide-maker 伺服器映像"

  depends_on = [google_project_service.enabled]
}

########################################
# 資料 bucket
########################################
resource "google_storage_bucket" "data" {
  name          = var.bucket_name
  location      = var.region
  storage_class = "STANDARD"

  # HNS 必須搭配 uniform bucket-level access。開 HNS 是為了原子 rename——
  # repository.ts 與 model-library-repository.ts 都靠「寫暫存檔再 rename」保證
  # 原子寫入，一般 flat bucket 的 rename 是 copy+delete，撐不住這個假設。
  uniform_bucket_level_access = true
  hierarchical_namespace {
    enabled = true
  }

  # 這個 bucket 會存 models.json，裡面是明文 API key（模型庫由 UI 管理）。
  # 公開存取一律封死，只有下面那個 service account 讀得到。
  public_access_prevention = "enforced"

  # 刻意沒開 versioning：GCS 不允許 HNS bucket 啟用物件版本控制
  # （API 回 400 "Versioning is not supported for hierarchical namespace buckets"）。
  # 原子 rename 是正確性需求，版本歷史不是，所以取前者。誤刪沒有平台層的復原
  # 手段——真的在意就自己定期 gsutil rsync 一份到別的 bucket。

  depends_on = [google_project_service.enabled]
}

########################################
# 執行身分
########################################
resource "google_service_account" "run" {
  account_id   = "${var.service_name}-run"
  display_name = "slide-maker Cloud Run runtime"
}

# objectUser 含 storage.folders.rename（HNS 原子 rename 需要），
# 且不含 objectAdmin 的 IAM 設定權限。
resource "google_storage_bucket_iam_member" "run_object_user" {
  bucket = google_storage_bucket.data.name
  role   = "roles/storage.objectUser"
  member = google_service_account.run.member
}

# gcsfuse 掛載時要讀 bucket metadata。
resource "google_storage_bucket_iam_member" "run_bucket_reader" {
  bucket = google_storage_bucket.data.name
  role   = "roles/storage.legacyBucketReader"
  member = google_service_account.run.member
}

########################################
# Cloud Run service
########################################
resource "google_cloud_run_v2_service" "app" {
  name     = var.service_name
  location = var.region

  deletion_protection = false
  ingress             = "INGRESS_TRAFFIC_ALL"

  # 必須明寫。省略這個屬性不等於「交給 console 決定」——Terraform 會送 null 過去，
  # 把手動啟用的 IAP 關掉。刻意不用 lifecycle.ignore_changes：IAP 是這個服務對外的
  # 驗證邊界，被誰關掉時 plan 應該要吵，而不是沉默接受。
  #
  # OAuth client 與使用者授權仍在 console 手動管理（IAP OAuth Admin API 已於
  # 2026-03 關閉，無組織專案無法用 API 建立 OAuth client）。
  iap_enabled = true

  template {
    service_account = google_service_account.run.email

    # gen2 是 GCS volume mount 的必要條件。
    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"

    # PDF 匯入最多 150 頁，取 Cloud Run 允許的上限。
    timeout = "3600s"

    scaling {
      # 最多一個實例是正確性要求，不是效能調校：job 狀態在 jobs.ts 的記憶體
      # Map 裡，而 gcsfuse 沒有檔案鎖——兩個實例會同時毀掉 job 追蹤與資料。
      min_instance_count = 0
      max_instance_count = 1
    }

    volumes {
      name = "data"
      gcs {
        bucket    = google_storage_bucket.data.name
        read_only = false
      }
    }

    containers {
      image = var.image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "4Gi"
        }
        # cpu_idle = false 就是「CPU always allocated」。JobRunner 在 HTTP 回應
        # 之後才於背景跑生成工作，被節流就等於工作停擺。
        cpu_idle          = false
        startup_cpu_boost = true
      }

      volume_mounts {
        name       = "data"
        mount_path = "/data"
      }

      env {
        name  = "SLIDE_MAKER_DATA_ROOT"
        value = "/data"
      }

      env {
        name  = "HOST"
        value = "0.0.0.0"
      }

      # 空字串等同「未設定」，app.ts 會退回只允許 localhost，也就是全部 403。
      env {
        name  = "SLIDE_MAKER_TRUSTED_HOSTS"
        value = join(",", var.trusted_hosts)
      }

      # SQLite FTS 索引不能放在 /data：gcsfuse 沒有 POSIX 檔案鎖，WAL 模式會靜默
      # 損毀。它是啟動時從 project.sources 全量重建的衍生資料，放容器本機即可。
      # 注意 Cloud Run 的本機磁碟是記憶體，這份索引會算進 4GiB 額度。
      env {
        name  = "SLIDE_MAKER_SEARCH_INDEX_PATH"
        value = "/tmp/slide-maker-index/sources.sqlite"
      }

      # 刻意不設任何 AI 相關環境變數：app.ts 只在「首次開機且 models.json
      # 不存在」時用 env seed 一份模型庫，之後 DATA_ROOT/models.json 就是單一
      # 真實來源。連線與 API key 一律在 UI 設定。

      startup_probe {
        http_get {
          path = "/api/health"
        }
        # 冷啟動要拉 ~2GB 映像、掛 gcsfuse、再由 recoverInterruptedJobs() 掃過
        # 所有專案，給到 5 分鐘。
        initial_delay_seconds = 10
        period_seconds        = 10
        timeout_seconds       = 5
        failure_threshold     = 30
      }

      # 刻意不設 liveness_probe：長時間的影像生成或 PDF render 可能讓探測逾時，
      # 進而在工作進行中殺掉唯一的實例。
    }
  }

  depends_on = [
    google_project_service.enabled,
    google_storage_bucket_iam_member.run_object_user,
    google_storage_bucket_iam_member.run_bucket_reader,
  ]
}

# 刻意「沒有」把 roles/run.invoker 給 allUsers。這個 service 預設就需要驗證，
# 在 IAP 設好之前對外一律 403。IAP 由人手動在 console 設定，不由 Terraform 管，
# 所以這裡也不設 iap_enabled——避免與手動設定互相覆寫。
