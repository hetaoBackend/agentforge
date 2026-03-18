# Backend Quality Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sustainable Python backend quality baseline with Ruff linting/formatting, pytest coverage, and GitHub Actions CI gates.

**Architecture:** Keep the current backend structure intact, add tool configuration centrally in `pyproject.toml`, and introduce a thin testable seam where needed. Build around the existing `tests/` suite instead of replacing it, then expose one local verification entrypoint through `Makefile` and reuse it in CI.

**Tech Stack:** Python 3.12, uv, Ruff, pytest, pytest-cov, GitHub Actions

---

### Task 1: Baseline Audit And Tracking

**Files:**
- Modify: `docs/todo.md`
- Create: `docs/superpowers/plans/2026-03-18-backend-quality-baseline.md`

- [x] **Step 1: Record the work in project tracking**
- [x] **Step 2: Save the implementation plan before code changes**

### Task 2: Tooling Configuration

**Files:**
- Modify: `pyproject.toml`
- Modify: `Makefile`

- [ ] **Step 1: Add a failing lint/test entrypoint expectation**
  - Run: `make check`
  - Expected: fail because lint targets/config are missing
- [ ] **Step 2: Add dev dependencies and tool config**
  - Add `ruff` and `pytest-cov`
  - Add `tool.ruff`, `tool.pytest.ini_options`, and coverage config
- [ ] **Step 3: Add Makefile commands**
  - Add `lint`, `format`, `format-check`, `test`, `test-cov`, `check`
- [ ] **Step 4: Re-run focused verification**
  - Run: `uv run ruff check .`
  - Run: `uv run pytest`

### Task 3: Test-First Coverage Fixes

**Files:**
- Modify: `tests/conftest.py`
- Create or Modify: `tests/test_helpers.py`
- Create or Modify: targeted backend tests as needed
- Modify: backend Python files only when a failing test proves a seam is needed

- [ ] **Step 1: Write or tighten one failing test at a time**
  - Cover `_get_env()` and one database or scheduling seam
- [ ] **Step 2: Run the focused test and confirm the failure is correct**
- [ ] **Step 3: Make the minimal implementation/config change**
- [ ] **Step 4: Re-run the focused test until green**

### Task 4: CI Workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Add CI for `pull_request` and `push` to `main`**
- [ ] **Step 2: Install Python 3.12 and uv**
- [ ] **Step 3: Run `uv sync --dev` and `make check`**
- [ ] **Step 4: Confirm the workflow matches local verification commands**

### Task 5: Final Verification And Tracking

**Files:**
- Modify: `docs/todo.md`

- [ ] **Step 1: Run full project verification**
  - Run: `make check`
- [ ] **Step 2: Update tracking entry with completed status and evidence**
- [ ] **Step 3: Summarize changes and any follow-up recommendations**
