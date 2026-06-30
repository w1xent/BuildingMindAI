// Command api — entrypoint HTTP-сервиса BuildingMind AI (MVP backend).
//
// Запуск:
//
//	cd backend
//	go run ./cmd/api
//
// По умолчанию слушает :8080, конфиг систем читает из data/systems.json
// (см. internal/config). Переменные окружения: BM_ENV, BM_ADDR,
// BM_SYSTEMS_CONFIG, BM_ALLOWED_ORIGIN — см. internal/config.Load.
package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/w1xent/buildingmindai/backend/internal/analysis"
	"github.com/w1xent/buildingmindai/backend/internal/config"
	"github.com/w1xent/buildingmindai/backend/internal/httpapi"
	"github.com/w1xent/buildingmindai/backend/internal/problems"
	"github.com/w1xent/buildingmindai/backend/internal/systems"
	"github.com/w1xent/buildingmindai/backend/pkg/logger"
)

func main() {
	cfg := config.Load()
	log := logger.New(cfg.Env)

	// ── Composition root: здесь и только здесь "собираются" все слои. ──
	// Каждая зависимость передаётся через интерфейс, поэтому замена любой
	// части (in-memory -> Postgres, локальный анализ -> вызов в Python
	// AI/ML Service) — это правка нескольких строк здесь, без изменений
	// в internal/httpapi или internal/problems.
	systemsLoader := systems.NewFileLoader(cfg.SystemsConfigPath)

	// Прогреваем загрузку конфигурации систем один раз на старте — чтобы
	// упасть с понятной ошибкой сразу, а не на первом запросе.
	if _, err := systemsLoader.Load(); err != nil {
		log.Error("failed to load systems config on startup", "error", err, "path", cfg.SystemsConfigPath)
		os.Exit(1)
	}

	engine := analysis.NewLocalEngine()
	statusStore := problems.NewMemoryStatusStore()
	svc := problems.NewService(engine, systemsLoader, statusStore)

	router := httpapi.NewRouter(svc, log)

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	// ── Graceful shutdown ────────────────────────────────────────────
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Info("http_server_starting", "addr", cfg.Addr, "env", cfg.Env)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http_server_failed", "error", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	log.Info("http_server_stopping")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("http_server_shutdown_failed", "error", err)
	}
}
