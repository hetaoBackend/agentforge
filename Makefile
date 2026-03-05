.PHONY: help build-backend build-electron package-dmg clean install-deps

# 项目配置
PROJECT_NAME = AgentForge
BACKEND_SRC = taskboard.py
BACKEND_BINARY = taskboard-electron/resources/taskboard
ELECTRON_DIR = taskboard-electron
DMG_OUTPUT = $(ELECTRON_DIR)/out/make/$(PROJECT_NAME)-1.0.0-arm64.dmg

help:
	@echo "AgentForge 打包工具"
	@echo ""
	@echo "可用命令:"
	@echo "  make help              - 显示此帮助信息"
	@echo "  make install-deps      - 安装项目依赖"
	@echo "  make build-backend     - 构建Python后端二进制文件"
	@echo "  make build-electron    - 构建Electron应用"
	@echo "  make package-dmg       - 打包为DMG文件（包含所有步骤）"
	@echo "  make clean             - 清理构建文件"
	@echo ""
	@echo "快速打包: make package-dmg"

install-deps:
	@echo "安装Python依赖..."
	uv add pyinstaller croniter python-dateutil pytz
	@echo "安装Electron依赖..."
	cd $(ELECTRON_DIR) && npm install

build-backend:
	@echo "构建Python后端二进制文件..."
	uv run pyinstaller --onefile --name taskboard \
		--distpath $(ELECTRON_DIR)/resources \
		--hidden-import croniter --hidden-import dateutil --hidden-import pytz \
		$(BACKEND_SRC)
	@echo "后端二进制文件位置: $(BACKEND_BINARY)"
	@ls -lh $(BACKEND_BINARY)

build-electron:
	@echo "构建Electron应用..."
	cd $(ELECTRON_DIR) && npm run package
	@echo "Electron应用构建完成"

package-dmg: build-backend build-electron
	@echo "打包DMG文件..."
	cd $(ELECTRON_DIR) && npm run make
	@if [ -f "$(DMG_OUTPUT)" ]; then \
		echo "DMG文件生成成功: $(DMG_OUTPUT)"; \
		ls -lh "$(DMG_OUTPUT)"; \
	else \
		echo "错误: DMG文件未生成"; \
		exit 1; \
	fi

clean:
	@echo "清理构建文件..."
	rm -rf build/
	rm -rf $(ELECTRON_DIR)/out/
	rm -rf $(ELECTRON_DIR)/.vite/
	rm -f $(BACKEND_BINARY)
	@echo "清理完成"

# 开发相关命令
dev-backend:
	@echo "启动后端开发服务器..."
	uv run python $(BACKEND_SRC)

dev-electron:
	@echo "启动Electron开发模式..."
	cd $(ELECTRON_DIR) && npm start

# 检查命令
check-backend:
	@echo "检查后端健康状态..."
	curl -f http://127.0.0.1:9712/api/health || echo "后端未运行"

check-dmg:
	@if [ -f "$(DMG_OUTPUT)" ]; then \
		echo "DMG文件存在: $(DMG_OUTPUT)"; \
		ls -lh "$(DMG_OUTPUT)"; \
	else \
		echo "DMG文件不存在"; \
	fi