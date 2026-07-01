.PHONY: help build-resources build-electrobun package-dmg clean install-deps lint format format-check test test-cov check dev-backend dev-electrobun check-backend check-dmg

# 项目配置
PROJECT_NAME = AgentForge
BACKEND_DIR = backend
APP_DIR = taskboard-electron
WEIXIN_BRIDGE = $(APP_DIR)/resources/weixin-bridge
DMG_OUTPUT = $(APP_DIR)/build/stable-macos-arm64/$(PROJECT_NAME).dmg

help:
	@echo "AgentForge 打包工具 (Bun + TypeScript)"
	@echo ""
	@echo "可用命令:"
	@echo "  make help              - 显示此帮助信息"
	@echo "  make install-deps      - 安装项目依赖 (bun install)"
	@echo "  make build-resources   - 编译 Electrobun 侧车资源"
	@echo "  make build-electrobun  - 构建 Electrobun 应用"
	@echo "  make package-dmg       - 打包为DMG文件（包含所有步骤）"
	@echo "  make clean             - 清理构建文件"
	@echo ""
	@echo "快速打包: make package-dmg"

install-deps:
	@echo "安装后端依赖..."
	cd $(BACKEND_DIR) && bun install
	@echo "安装 Electrobun 应用依赖..."
	cd $(APP_DIR) && bun install

build-resources:
	@echo "编译 Electrobun 侧车资源..."
	cd $(APP_DIR) && bun run build:resources
	@echo "Weixin bridge 位置: $(WEIXIN_BRIDGE)"
	@ls -lh $(WEIXIN_BRIDGE)

build-electrobun:
	@echo "构建 Electrobun 应用..."
	cd $(APP_DIR) && bun run build
	@echo "Electrobun 应用构建完成"

package-dmg:
	@echo "打包DMG文件..."
	cd $(APP_DIR) && bun run make
	@if [ -f "$(DMG_OUTPUT)" ]; then \
		echo "DMG文件生成成功: $(DMG_OUTPUT)"; \
		ls -lh "$(DMG_OUTPUT)"; \
	else \
		echo "错误: DMG文件未生成"; \
		exit 1; \
	fi

clean:
	@echo "清理构建文件..."
	rm -rf $(APP_DIR)/build/
	rm -rf $(APP_DIR)/artifacts/
	rm -rf $(APP_DIR)/.bun/
	rm -f $(APP_DIR)/resources/taskboard
	rm -f $(WEIXIN_BRIDGE)
	@echo "清理完成"

# 开发相关命令
dev-backend:
	@echo "启动后端开发服务器..."
	cd $(BACKEND_DIR) && bun taskboard.ts

dev-electrobun:
	@echo "启动 Electrobun 开发模式..."
	cd $(APP_DIR) && bun run start

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

lint:
	@echo "运行 TypeScript 类型检查..."
	cd $(BACKEND_DIR) && bun run typecheck

format:
	@echo "运行 Prettier format..."
	cd $(BACKEND_DIR) && bun run format

format-check:
	@echo "检查代码格式..."
	cd $(BACKEND_DIR) && bun run format:check

test:
	@echo "运行后端测试..."
	cd $(BACKEND_DIR) && bun test

test-cov:
	@echo "运行后端测试并检查覆盖率..."
	cd $(BACKEND_DIR) && bun test --coverage

check:
	cd $(BACKEND_DIR) && bun run check
