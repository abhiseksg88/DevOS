"""
DAG Scheduler — Manages parallel node execution in the agent pipeline.

Provides a DAG execution engine that can run independent nodes
concurrently while respecting dependencies. Used for parallel
sub-agent tasks within the coder node.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)


@dataclass
class DAGNode:
    """A node in the execution DAG."""
    id: str
    fn: Callable[..., Awaitable[Any]]
    dependencies: list[str] = field(default_factory=list)
    outputs: dict[str, Any] = field(default_factory=dict)
    status: str = "pending"  # pending, running, completed, failed
    error: str | None = None


class DAGScheduler:
    """Execute a DAG of tasks with maximum parallelism."""

    def __init__(self, max_concurrency: int = 5):
        self.nodes: dict[str, DAGNode] = {}
        self.semaphore = asyncio.Semaphore(max_concurrency)

    def add_node(
        self,
        node_id: str,
        fn: Callable[..., Awaitable[Any]],
        dependencies: list[str] | None = None,
    ) -> None:
        self.nodes[node_id] = DAGNode(
            id=node_id,
            fn=fn,
            dependencies=dependencies or [],
        )

    async def execute(self, context: dict[str, Any]) -> dict[str, Any]:
        """Execute all nodes respecting dependencies. Returns merged outputs."""
        tasks: dict[str, asyncio.Task] = {}
        results: dict[str, Any] = {}

        while self._has_pending():
            ready = self._get_ready_nodes()
            if not ready and tasks:
                done, _ = await asyncio.wait(
                    tasks.values(),
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in done:
                    node_id = next(k for k, v in tasks.items() if v == task)
                    del tasks[node_id]
                    try:
                        result = task.result()
                        self.nodes[node_id].outputs = result or {}
                        self.nodes[node_id].status = "completed"
                        results[node_id] = result
                    except Exception as e:
                        self.nodes[node_id].status = "failed"
                        self.nodes[node_id].error = str(e)
                        logger.error("DAG node %s failed: %s", node_id, e)
                continue

            if not ready:
                break

            for node in ready:
                node.status = "running"
                dep_outputs = {}
                for dep_id in node.dependencies:
                    dep_outputs.update(self.nodes[dep_id].outputs)

                merged_ctx = {**context, **dep_outputs}
                tasks[node.id] = asyncio.create_task(
                    self._run_with_semaphore(node, merged_ctx)
                )

        # Wait for remaining tasks
        if tasks:
            done_tasks = await asyncio.gather(*tasks.values(), return_exceptions=True)
            for node_id, result in zip(tasks.keys(), done_tasks):
                if isinstance(result, Exception):
                    self.nodes[node_id].status = "failed"
                    self.nodes[node_id].error = str(result)
                else:
                    self.nodes[node_id].status = "completed"
                    self.nodes[node_id].outputs = result or {}
                    results[node_id] = result

        return results

    async def _run_with_semaphore(self, node: DAGNode, context: dict) -> Any:
        async with self.semaphore:
            return await node.fn(context)

    def _has_pending(self) -> bool:
        return any(n.status in ("pending", "running") for n in self.nodes.values())

    def _get_ready_nodes(self) -> list[DAGNode]:
        ready = []
        for node in self.nodes.values():
            if node.status != "pending":
                continue
            deps_met = all(
                self.nodes[dep].status == "completed"
                for dep in node.dependencies
                if dep in self.nodes
            )
            if deps_met:
                ready.append(node)
        return ready
