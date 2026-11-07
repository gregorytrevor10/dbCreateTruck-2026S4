# Sandbox tasks. Run from this folder: make up
#
# Every target reads sandbox/.env if it exists, and falls back to .env.example
# values otherwise. Nothing here holds a credential.

COMPOSE ?= docker compose
ENV_FILE := $(wildcard .env)
ifneq ($(ENV_FILE),)
include .env
export
endif

PGUSER ?= trk
PGPASSWORD ?= trk
PGDATABASE ?= trk
PGPORT ?= 5433
UI_PORT ?= 8099

URL := http://127.0.0.1:$(UI_PORT)

.PHONY: help up down reset seed psql state apply1 apply2 apply3 logs check

help:
	@echo "make up       start db + console, seed on first boot"
	@echo "make down     stop, keep the data volume"
	@echo "make reset    stop, delete the volume, start fresh"
	@echo "make seed     replay the seed file over the running database"
	@echo "make psql     interactive psql inside the db container"
	@echo "make apply1   run submission/task1/solution1.sql"
	@echo "make apply2   run submission/task2/solution2.sql"
	@echo "make apply3   run submission/task3/solution3.sql"
	@echo "make state    object counts and server version"
	@echo "make logs     follow container logs"

up:
	$(COMPOSE) up -d --build
	@echo "console: $(URL)"

down:
	$(COMPOSE) down

reset:
	$(COMPOSE) down -v
	$(COMPOSE) up -d --build
	@echo "console: $(URL) (reseeded)"

seed:
	@curl -fsS -X POST $(URL)/api/reseed | head -c 400; echo

psql:
	$(COMPOSE) exec db psql -U $(PGUSER) -d $(PGDATABASE)

state:
	@curl -fsS $(URL)/api/state

apply1:
	@curl -fsS -X POST $(URL)/api/apply -H 'content-type: application/json' -d '{"task":"task1"}' | head -c 400; echo

apply2:
	@curl -fsS -X POST $(URL)/api/apply -H 'content-type: application/json' -d '{"task":"task2"}' | head -c 400; echo

apply3:
	@curl -fsS -X POST $(URL)/api/apply -H 'content-type: application/json' -d '{"task":"task3"}' | head -c 400; echo

logs:
	$(COMPOSE) logs -f app
