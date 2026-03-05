#!/usr/bin/env python3
"""
AgentForge CLI - Command-line interface for AgentForge API

Usage:
  agentforge_api.py --method create --prompt "..." [options]
  agentforge_api.py --method list [--status STATUS]
  agentforge_api.py --method get --task-id ID
  agentforge_api.py --method runs --task-id ID
  agentforge_api.py --method output --task-id ID
  agentforge_api.py --method events --task-id ID [--limit N]
  agentforge_api.py --method cancel --task-id ID
  agentforge_api.py --method retry --task-id ID
  agentforge_api.py --method delete --task-id ID
  agentforge_api.py --method dag --dag-id ID
  agentforge_api.py --method health

Examples:
  agentforge_api.py --method create --prompt "Run tests" --title "Test run" --dir /path/to/project
  agentforge_api.py --method create --prompt "Backup" --schedule delayed --delay 300
  agentforge_api.py --method create --prompt "Deploy" --schedule scheduled_at --at "2026-02-15 14:30:00"
  agentforge_api.py --method create --prompt "Daily report" --schedule cron --cron "0 2 * * *"
  agentforge_api.py --method create --prompt "Step 2" --depends-on 10,11 --inject-result --dag-id my-pipeline
  agentforge_api.py --method list --status running
  agentforge_api.py --method get --task-id 5
  agentforge_api.py --method output --task-id 5
  agentforge_api.py --method retry --task-id 5
  agentforge_api.py --method delete --task-id 5
  agentforge_api.py --method dag --dag-id my-pipeline
"""

import argparse
import json
import sys
import os
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime


API_BASE = "http://127.0.0.1:9712/api"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def api_request(method, path, json_data=None, params=None):
    """Make HTTP request to AgentForge API using stdlib only."""
    url = f"{API_BASE}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)

    body = None
    headers = {}
    if json_data is not None:
        body = json.dumps(json_data).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=body, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as e:
        if isinstance(e, urllib.error.HTTPError):
            try:
                err_body = json.loads(e.read().decode("utf-8"))
                detail = err_body.get("error", e.reason)
            except Exception:
                detail = e.reason
            print(f"API error (HTTP {e.code}): {detail}", file=sys.stderr)
        elif "Connection refused" in str(e.reason) or "No connection" in str(e.reason):
            print(
                "Connection failed: AgentForge is not running.\n"
                "Start it with: cd <project-root> && uv run taskboard.py",
                file=sys.stderr,
            )
        else:
            print(f"Network error: {e.reason}", file=sys.stderr)
        sys.exit(1)


STATUS_ICONS = {
    "pending": "🕐",
    "scheduled": "⏰",
    "running": "⏳",
    "completed": "✅",
    "failed": "❌",
    "cancelled": "🚫",
    "blocked": "⊘",
}


def main():
    parser = argparse.ArgumentParser(
        description="AgentForge CLI - Manage AI agent tasks",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    parser.add_argument(
        "--method",
        required=True,
        choices=[
            "create", "list", "get", "runs", "output", "events",
            "cancel", "retry", "delete", "dag", "health",
        ],
        help="API method to call",
    )

    # Task creation parameters
    parser.add_argument("--prompt", help="Task prompt/instruction (for create)")
    parser.add_argument("--title", help="Task title (for create)")
    parser.add_argument("--dir", default=".", help="Working directory (for create, default: .)")
    parser.add_argument(
        "--schedule",
        choices=["immediate", "delayed", "scheduled_at", "cron"],
        default="immediate",
        help="Schedule type (for create)",
    )
    parser.add_argument("--cron", help="Cron expression (for create with schedule=cron)")
    parser.add_argument("--delay", type=int, help="Delay in seconds (for create with schedule=delayed)")
    parser.add_argument("--at", help="Specific datetime (for create with schedule=scheduled_at, format: 'YYYY-MM-DD HH:MM:SS')")
    parser.add_argument("--max-runs", type=int, help="Max runs for cron tasks (for create)")
    parser.add_argument("--tags", default="", help="Comma-separated tags (for create)")
    parser.add_argument("--image-paths", help="Comma-separated list of image file paths (for create)")
    # DAG parameters
    parser.add_argument("--depends-on", help="Comma-separated upstream task IDs (for create), e.g. '10,11'")
    parser.add_argument("--inject-result", action="store_true", help="Inject upstream results into prompt (for create with --depends-on)")
    parser.add_argument("--dag-id", help="DAG workflow group label (for create or dag method)")

    # Query parameters
    parser.add_argument("--task-id", type=int, help="Task ID (for get/runs/output/events/cancel/retry/delete)")
    parser.add_argument("--status", help="Filter by status (for list)")
    parser.add_argument("--limit", type=int, default=1000, help="Max events to return (for events)")
    parser.add_argument("--offset", type=int, default=0, help="Events to skip (for events)")

    # Output formatting
    parser.add_argument("--json", action="store_true", help="Output as JSON (for list/output)")

    args = parser.parse_args()

    # Route to appropriate handler
    if args.method == "create":
        if not args.prompt:
            parser.error("--prompt is required for create method")

        data = {
            "prompt": args.prompt,
            "title": args.title or args.prompt[:60],
            "working_dir": args.dir,
            "schedule_type": args.schedule,
            "tags": args.tags,
        }

        if args.cron:
            data["cron_expr"] = args.cron
        if args.delay:
            data["delay_seconds"] = args.delay
        if args.at:
            try:
                dt = datetime.strptime(args.at, "%Y-%m-%d %H:%M:%S")
                data["next_run_at"] = dt.isoformat()
            except ValueError:
                print("Error: --at must be in format 'YYYY-MM-DD HH:MM:SS'", file=sys.stderr)
                sys.exit(1)
        if args.max_runs:
            data["max_runs"] = args.max_runs
        if args.dag_id:
            data["dag_id"] = args.dag_id
        if args.image_paths:
            paths = [p.strip() for p in args.image_paths.split(",") if p.strip()]
            data["image_paths"] = paths
        if args.depends_on:
            ids = [int(x.strip()) for x in args.depends_on.split(",") if x.strip().isdigit()]
            data["depends_on"] = [
                {"task_id": tid, "inject_result": args.inject_result}
                for tid in ids
            ]

        result = api_request("POST", "/tasks", json_data=data)
        print(json.dumps(result, indent=2))

    elif args.method == "list":
        tasks = api_request("GET", "/tasks")

        if args.status:
            tasks = [t for t in tasks if t["status"] == args.status]

        if args.json:
            print(json.dumps(tasks, indent=2))
        else:
            if not tasks:
                print("No tasks found.")
            for task in tasks:
                icon = STATUS_ICONS.get(task["status"], "❓")
                dag_label = f" [dag:{task['dag_id']}]" if task.get("dag_id") else ""
                print(f"{icon} #{task['id']}: {task['title']} ({task['status']}){dag_label}")

    elif args.method == "get":
        if not args.task_id:
            parser.error("--task-id is required for get method")
        task = api_request("GET", f"/tasks/{args.task_id}")
        print(json.dumps(task, indent=2))

    elif args.method == "runs":
        if not args.task_id:
            parser.error("--task-id is required for runs method")
        runs = api_request("GET", f"/tasks/{args.task_id}/runs")
        print(json.dumps(runs, indent=2))

    elif args.method == "output":
        if not args.task_id:
            parser.error("--task-id is required for output method")
        result = api_request("GET", f"/tasks/{args.task_id}/output")

        if args.json:
            print(json.dumps(result, indent=2))
        else:
            if result["is_running"]:
                print("Status: Running")
                print("\nOutput:")
            else:
                print("Status: Not running")
            print(result["output"])

    elif args.method == "events":
        if not args.task_id:
            parser.error("--task-id is required for events method")
        params = {"limit": args.limit, "offset": args.offset}
        result = api_request("GET", f"/tasks/{args.task_id}/events", params=params)
        print(json.dumps(result, indent=2))

    elif args.method == "cancel":
        if not args.task_id:
            parser.error("--task-id is required for cancel method")
        result = api_request("POST", f"/tasks/{args.task_id}/cancel")
        print(json.dumps(result, indent=2))

    elif args.method == "retry":
        if not args.task_id:
            parser.error("--task-id is required for retry method")
        result = api_request("POST", f"/tasks/{args.task_id}/retry")
        print(json.dumps(result, indent=2))

    elif args.method == "delete":
        if not args.task_id:
            parser.error("--task-id is required for delete method")
        req = urllib.request.Request(
            f"{API_BASE}/tasks/{args.task_id}", method="DELETE"
        )
        try:
            with urllib.request.urlopen(req) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                print(json.dumps(result, indent=2))
        except urllib.error.HTTPError as e:
            try:
                err_body = json.loads(e.read().decode("utf-8"))
                detail = err_body.get("error", e.reason)
            except Exception:
                detail = e.reason
            print(f"API error (HTTP {e.code}): {detail}", file=sys.stderr)
            sys.exit(1)

    elif args.method == "dag":
        if not args.dag_id:
            parser.error("--dag-id is required for dag method")
        tasks = api_request("GET", f"/dag/{args.dag_id}")
        if args.json:
            print(json.dumps(tasks, indent=2))
        else:
            print(f"DAG: {args.dag_id} ({len(tasks)} tasks)")
            for task in tasks:
                icon = STATUS_ICONS.get(task["status"], "❓")
                deps = task.get("dependencies", [])
                dep_ids = ", ".join(f"#{d['depends_on_task_id']}" for d in deps)
                dep_label = f" <- {dep_ids}" if deps else ""
                print(f"  {icon} #{task['id']}: {task['title']} ({task['status']}){dep_label}")

    elif args.method == "health":
        result = api_request("GET", "/health")
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
