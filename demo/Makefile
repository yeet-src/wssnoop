PORT ?= 8080

.PHONY: demo browser stop
demo: ## Start headless traffic (3 workers × coinbase+kraken+poly) and attach wssnoop
	@./run.sh --attach

browser: ## Browser demo: run server.js in the VM, forwarded to host :PORT
	@PORT=$(PORT) ./run-browser.sh

stop: ## Stop the demo workers
	@./run.sh --stop
