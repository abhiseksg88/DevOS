"""
Neural Nexus Engine — The Shared State Manager

This is the core of Vedaa's competitive advantage. It maintains a dynamic
knowledge graph across three dimensions and provides context retrieval
for all agents in the swarm.

The engine:
  1. Retrieves rich context for any agent call (UPP + PSM + Business Logic)
  2. Records feedback from every interaction (the flywheel)
  3. Learns user preferences automatically from accepted/rejected code
  4. Maintains the Project State Matrix from generated code analysis
  5. Tracks business logic annotations for semantic code understanding
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from ..api.config import Settings

logger = logging.getLogger(__name__)


def _get_db(settings: Settings):
    from supabase import create_client
    return create_client(settings.supabase_url, settings.supabase_service_role_key)


# ============================================================================
# Context Retrieval — Feed agents with rich knowledge
# ============================================================================

class NexusContext:
    """Assembled context from all five dimensions for an agent call."""

    def __init__(
        self,
        user_persona: dict,
        project_state: dict,
        business_logic: list[dict],
        recent_feedback: list[dict],
        agent_role: str,
        component_context: str = "",
        observability_context: str = "",
    ):
        self.user_persona = user_persona
        self.project_state = project_state
        self.business_logic = business_logic
        self.recent_feedback = recent_feedback
        self.agent_role = agent_role
        self.component_context = component_context
        self.observability_context = observability_context

    def to_prompt_section(self) -> str:
        """Render the context as a prompt section for the agent."""
        sections = []

        # --- User Persona ---
        prefs = self.user_persona.get("preferences", {})
        expertise = self.user_persona.get("expertise", {})
        history = self.user_persona.get("history", [])

        if prefs or expertise:
            persona_lines = ["## User Persona Protocol"]
            if expertise:
                primary_langs = expertise.get("primary_languages", [])
                depth = expertise.get("explanation_depth", "standard")
                levels = []
                for domain in ["frontend", "backend", "devops", "database", "security"]:
                    level = expertise.get(domain)
                    if level:
                        levels.append(f"  - {domain.title()}: {level}")
                if levels:
                    persona_lines.append("### Expertise")
                    persona_lines.extend(levels)
                if primary_langs:
                    persona_lines.append(f"### Primary Languages: {', '.join(primary_langs)}")
                persona_lines.append(f"### Explanation Depth: {depth}")

            if prefs:
                persona_lines.append("### Preferences")
                style = prefs.get("coding_style")
                if style:
                    persona_lines.append(f"  - Coding style: {style}")
                fw_prefs = prefs.get("framework_prefs", {})
                for fw, choice in fw_prefs.items():
                    persona_lines.append(f"  - {fw}: prefers {choice}")
                lib_prefs = prefs.get("library_prefs", {})
                for lib, choice in lib_prefs.items():
                    persona_lines.append(f"  - {lib}: prefers {choice}")
                dislikes = prefs.get("dislikes", [])
                if dislikes:
                    persona_lines.append(f"  - Dislikes: {', '.join(dislikes)}")
                spelling = prefs.get("spelling")
                if spelling:
                    persona_lines.append(f"  - Spelling: {spelling}")
                verbosity = prefs.get("verbosity")
                if verbosity:
                    persona_lines.append(f"  - Verbosity: {verbosity}")

            # Recent history (last 5 decisions)
            if history:
                recent = history[-5:] if isinstance(history, list) else []
                if recent:
                    persona_lines.append("### Recent Decisions")
                    for h in recent:
                        outcome = h.get("outcome", "unknown")
                        decision = h.get("decision", "")
                        reason = h.get("reason", "")
                        icon = "+" if outcome == "success" else "-"
                        line = f"  {icon} {decision}"
                        if reason:
                            line += f" ({reason})"
                        persona_lines.append(line)

            sections.append("\n".join(persona_lines))

        # --- Project State Matrix ---
        if self.project_state:
            psm_lines = ["## Project State Matrix"]

            health = self.project_state.get("health_score", 100)
            psm_lines.append(f"### Health Score: {health}/100")

            # File graph summary
            file_graph = self.project_state.get("file_graph", {})
            if file_graph:
                file_count = len(file_graph)
                components = [f for f, info in file_graph.items()
                              if isinstance(info, dict) and info.get("type") == "react_component"]
                psm_lines.append(f"### Codebase: {file_count} files, {len(components)} React components")

            # Dependency graph summary
            dep_graph = self.project_state.get("dependency_graph", {})
            services = dep_graph.get("services", {})
            if services:
                psm_lines.append("### Service Dependencies")
                for svc, info in list(services.items())[:10]:
                    calls = info.get("calls", [])
                    if calls:
                        psm_lines.append(f"  - {svc} → {', '.join(calls)}")

            # Tech debt (top 5 by severity)
            tech_debt = self.project_state.get("tech_debt", [])
            if tech_debt and isinstance(tech_debt, list):
                severity_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
                sorted_debt = sorted(tech_debt,
                                     key=lambda d: severity_order.get(d.get("severity", "low"), 3))
                top_debt = sorted_debt[:5]
                if top_debt:
                    psm_lines.append("### Technical Debt (Top Issues)")
                    for d in top_debt:
                        psm_lines.append(
                            f"  - [{d.get('severity', 'low').upper()}] {d.get('file', '?')}: "
                            f"{d.get('description', '?')}"
                        )

            sections.append("\n".join(psm_lines))

        # --- Business Logic ---
        if self.business_logic:
            bl_lines = ["## Business Logic Context"]
            for bl in self.business_logic[:15]:  # Cap at 15 entries
                bl_lines.append(
                    f"- **{bl.get('entity_name', '?')}** ({bl.get('entity_type', '?')} "
                    f"at `{bl.get('entity_path', '?')}`): {bl.get('purpose', '?')}"
                )
                rules = bl.get("business_rules", [])
                if rules and isinstance(rules, list):
                    for rule in rules[:3]:
                        bl_lines.append(f"  - Rule: {rule}")
            sections.append("\n".join(bl_lines))

        # --- Recent Feedback ---
        if self.recent_feedback:
            fb_lines = ["## Recent Feedback (Learn From This)"]
            for fb in self.recent_feedback[:5]:
                event = fb.get("event_type", "?")
                feedback = fb.get("feedback", {})
                if event == "code_rejected":
                    reason = feedback.get("reason", "No reason given")
                    fb_lines.append(f"  - REJECTED: {reason}")
                elif event == "preference_stated":
                    key = feedback.get("key", "?")
                    value = feedback.get("value", "?")
                    fb_lines.append(f"  - PREFERENCE: {key} = {value}")
                elif event == "style_correction":
                    pattern = feedback.get("pattern", "?")
                    fb_lines.append(f"  - STYLE: {pattern}")
                elif event == "library_preference":
                    fb_lines.append(f"  - LIBRARY: {json.dumps(feedback)}")
            sections.append("\n".join(fb_lines))

        # --- Component Library (Dimension 4) ---
        if self.component_context:
            sections.append(self.component_context)

        # --- Build Observability (Dimension 5) ---
        if self.observability_context:
            sections.append(self.observability_context)

        if not sections:
            return ""

        return (
            "\n\n━━━━━━━━━━━━ NEURAL NEXUS CONTEXT ━━━━━━━━━━━━\n\n"
            + "\n\n".join(sections)
            + "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        )


# ============================================================================
# Nexus Engine — Core state management
# ============================================================================

class NexusEngine:
    """The Neural Nexus state engine — manages all three dimensions."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.db = _get_db(settings)

    # -----------------------------------------------------------------------
    # Context Assembly — The main entry point for agents
    # -----------------------------------------------------------------------

    def get_context(
        self,
        tenant_id: str,
        project_id: str,
        user_id: str,
        agent_role: str,
        query: str = "",
    ) -> NexusContext:
        """Assemble full context from all five dimensions for an agent."""

        # 1. User Persona
        persona = self._get_or_create_persona(tenant_id, user_id)

        # 2. Project State Matrix
        psm = self._get_or_create_psm(tenant_id, project_id)

        # 3. Business Logic
        bl = self._get_business_logic(project_id)

        # 4. Recent Feedback
        feedback = self._get_recent_feedback(project_id, user_id, limit=10)

        # 5. Component Library (Dimension 4)
        component_ctx = ""
        if query:
            try:
                from ..services.component_rag import get_component_context
                component_ctx = get_component_context(project_id, query, self.settings)
            except Exception as e:
                logger.warning("Component RAG failed: %s", e)

        # 6. Observability Metrics (Dimension 5)
        obs_ctx = ""
        try:
            from ..services.observability import get_observability_context
            obs_ctx = get_observability_context(project_id, self.settings)
        except Exception as e:
            logger.warning("Observability context failed: %s", e)

        return NexusContext(
            user_persona=persona,
            project_state=psm,
            business_logic=bl,
            recent_feedback=feedback,
            agent_role=agent_role,
            component_context=component_ctx,
            observability_context=obs_ctx,
        )

    # -----------------------------------------------------------------------
    # User Persona Protocol (UPP)
    # -----------------------------------------------------------------------

    def _get_or_create_persona(self, tenant_id: str, user_id: str) -> dict:
        """Get or create user persona."""
        try:
            result = (
                self.db.table("user_persona")
                .select("*")
                .eq("tenant_id", tenant_id)
                .eq("user_id", user_id)
                .limit(1)
                .execute()
            )
            if result.data:
                return result.data[0]

            # Create default persona
            new_persona = {
                "id": str(uuid4()),
                "tenant_id": tenant_id,
                "user_id": user_id,
                "preferences": {},
                "expertise": {},
                "history": [],
            }
            self.db.table("user_persona").insert(new_persona).execute()
            return new_persona
        except Exception as e:
            logger.warning("Failed to get persona for %s: %s", user_id, e)
            return {"preferences": {}, "expertise": {}, "history": []}

    def update_persona_preference(
        self,
        tenant_id: str,
        user_id: str,
        key: str,
        value: Any,
    ) -> None:
        """Update a specific preference in the user persona.

        Key uses dot notation: "library_prefs.redis" → {"library_prefs": {"redis": value}}
        """
        persona = self._get_or_create_persona(tenant_id, user_id)
        prefs = persona.get("preferences", {})

        # Handle dot notation
        parts = key.split(".")
        current = prefs
        for part in parts[:-1]:
            if part not in current or not isinstance(current[part], dict):
                current[part] = {}
            current = current[part]
        current[parts[-1]] = value

        try:
            self.db.table("user_persona").update(
                {"preferences": prefs}
            ).eq("tenant_id", tenant_id).eq("user_id", user_id).execute()
        except Exception as e:
            logger.warning("Failed to update persona preference: %s", e)

    def update_persona_expertise(
        self,
        tenant_id: str,
        user_id: str,
        domain: str,
        level: str,
    ) -> None:
        """Update expertise level for a domain."""
        persona = self._get_or_create_persona(tenant_id, user_id)
        expertise = persona.get("expertise", {})
        expertise[domain] = level

        try:
            self.db.table("user_persona").update(
                {"expertise": expertise}
            ).eq("tenant_id", tenant_id).eq("user_id", user_id).execute()
        except Exception as e:
            logger.warning("Failed to update expertise: %s", e)

    def record_decision(
        self,
        tenant_id: str,
        user_id: str,
        decision: str,
        outcome: str,
        reason: str = "",
    ) -> None:
        """Record a historical decision in the persona."""
        persona = self._get_or_create_persona(tenant_id, user_id)
        history = persona.get("history", [])
        if not isinstance(history, list):
            history = []

        history.append({
            "decision": decision,
            "outcome": outcome,
            "reason": reason,
            "ts": datetime.now(timezone.utc).isoformat(),
        })

        # Keep last 50 decisions
        history = history[-50:]

        try:
            self.db.table("user_persona").update(
                {"history": history}
            ).eq("tenant_id", tenant_id).eq("user_id", user_id).execute()
        except Exception as e:
            logger.warning("Failed to record decision: %s", e)

    def increment_persona_stats(
        self,
        tenant_id: str,
        user_id: str,
        accepted: bool,
    ) -> None:
        """Increment prompt/accepted/rejected counters."""
        try:
            persona = self._get_or_create_persona(tenant_id, user_id)
            updates = {"total_prompts": persona.get("total_prompts", 0) + 1}
            if accepted:
                updates["total_accepted"] = persona.get("total_accepted", 0) + 1
            else:
                updates["total_rejected"] = persona.get("total_rejected", 0) + 1

            self.db.table("user_persona").update(updates).eq(
                "tenant_id", tenant_id
            ).eq("user_id", user_id).execute()
        except Exception as e:
            logger.warning("Failed to increment persona stats: %s", e)

    # -----------------------------------------------------------------------
    # Project State Matrix (PSM)
    # -----------------------------------------------------------------------

    def _get_or_create_psm(self, tenant_id: str, project_id: str) -> dict:
        """Get or create project state matrix."""
        try:
            result = (
                self.db.table("project_state_matrix")
                .select("*")
                .eq("project_id", project_id)
                .limit(1)
                .execute()
            )
            if result.data:
                return result.data[0]

            new_psm = {
                "id": str(uuid4()),
                "tenant_id": tenant_id,
                "project_id": project_id,
                "file_graph": {},
                "dependency_graph": {},
                "tech_debt": [],
                "dependencies": {},
                "health_score": 100,
            }
            self.db.table("project_state_matrix").insert(new_psm).execute()
            return new_psm
        except Exception as e:
            logger.warning("Failed to get PSM for project %s: %s", project_id, e)
            return {"file_graph": {}, "dependency_graph": {}, "tech_debt": [], "health_score": 100}

    def update_file_graph(
        self,
        tenant_id: str,
        project_id: str,
        files: dict[str, str],
    ) -> None:
        """Analyze files and update the file graph in PSM.

        This is a lightweight static analysis — extracts imports, exports,
        hooks used, and basic complexity metrics from the source code.
        """
        file_graph: dict[str, dict] = {}
        dependency_graph: dict[str, dict] = {"services": {}, "components": {}}

        for path, content in files.items():
            if not content:
                continue

            info: dict[str, Any] = {
                "lines": content.count("\n") + 1,
                "type": _classify_file(path, content),
            }

            # Extract imports
            imports = _extract_imports(content)
            if imports:
                info["imports"] = imports

            # Extract exports
            exports = _extract_exports(content)
            if exports:
                info["exports"] = exports

            # React hooks used
            hooks = _extract_hooks(content)
            if hooks:
                info["hooks_used"] = hooks

            # Complexity estimate
            info["complexity"] = _estimate_complexity(content)

            file_graph[path] = info

            # Build dependency graph
            if info["type"] == "react_component":
                name = exports[0].split(":")[-1] if exports else path.split("/")[-1].split(".")[0]
                dependency_graph["components"][name] = {
                    "file": path,
                    "imports": imports,
                }

        try:
            self.db.table("project_state_matrix").update({
                "file_graph": file_graph,
                "dependency_graph": dependency_graph,
                "last_analyzed_at": datetime.now(timezone.utc).isoformat(),
            }).eq("project_id", project_id).execute()
        except Exception as e:
            logger.warning("Failed to update file graph: %s", e)

    def tag_tech_debt(
        self,
        project_id: str,
        file: str,
        severity: str,
        description: str,
        tagged_by: str,
    ) -> None:
        """Tag a piece of technical debt in the PSM."""
        try:
            psm = (
                self.db.table("project_state_matrix")
                .select("tech_debt, health_score")
                .eq("project_id", project_id)
                .single()
                .execute()
            )
            tech_debt = psm.data.get("tech_debt", [])
            if not isinstance(tech_debt, list):
                tech_debt = []

            tech_debt.append({
                "file": file,
                "severity": severity,
                "description": description,
                "tagged_by": tagged_by,
                "tagged_at": datetime.now(timezone.utc).isoformat(),
            })

            # Recalculate health score
            severity_costs = {"critical": 20, "high": 10, "medium": 5, "low": 2}
            total_cost = sum(severity_costs.get(d.get("severity", "low"), 2) for d in tech_debt)
            health = max(0, 100 - total_cost)

            self.db.table("project_state_matrix").update({
                "tech_debt": tech_debt,
                "health_score": health,
            }).eq("project_id", project_id).execute()
        except Exception as e:
            logger.warning("Failed to tag tech debt: %s", e)

    # -----------------------------------------------------------------------
    # Business Logic Layer
    # -----------------------------------------------------------------------

    def _get_business_logic(self, project_id: str) -> list[dict]:
        """Get all business logic entries for a project."""
        try:
            result = (
                self.db.table("business_logic")
                .select("*")
                .eq("project_id", project_id)
                .order("confidence", desc=True)
                .limit(50)
                .execute()
            )
            return result.data or []
        except Exception as e:
            logger.warning("Failed to get business logic: %s", e)
            return []

    def upsert_business_logic(
        self,
        tenant_id: str,
        project_id: str,
        entity_type: str,
        entity_path: str,
        entity_name: str,
        purpose: str,
        domain: str | None = None,
        business_rules: list[str] | None = None,
        confidence: float = 0.5,
        source: str = "inferred",
    ) -> None:
        """Create or update a business logic entry."""
        try:
            self.db.table("business_logic").upsert({
                "id": str(uuid4()),
                "tenant_id": tenant_id,
                "project_id": project_id,
                "entity_type": entity_type,
                "entity_path": entity_path,
                "entity_name": entity_name,
                "purpose": purpose,
                "domain": domain,
                "business_rules": business_rules or [],
                "confidence": confidence,
                "source": source,
            }, on_conflict="project_id,entity_type,entity_path").execute()
        except Exception as e:
            logger.warning("Failed to upsert business logic: %s", e)

    # -----------------------------------------------------------------------
    # Feedback Flywheel
    # -----------------------------------------------------------------------

    def _get_recent_feedback(
        self,
        project_id: str,
        user_id: str,
        limit: int = 10,
    ) -> list[dict]:
        """Get recent feedback for context."""
        try:
            result = (
                self.db.table("nexus_feedback")
                .select("*")
                .eq("project_id", project_id)
                .eq("user_id", user_id)
                .order("created_at", desc=True)
                .limit(limit)
                .execute()
            )
            return result.data or []
        except Exception as e:
            logger.warning("Failed to get feedback: %s", e)
            return []

    def record_feedback(
        self,
        tenant_id: str,
        project_id: str,
        user_id: str,
        event_type: str,
        feedback: dict,
        agent: str | None = None,
        prompt: str | None = None,
        response_summary: str | None = None,
    ) -> None:
        """Record feedback and apply updates to the knowledge graph.

        This is the core of the flywheel — every piece of feedback
        automatically updates the relevant dimension of the Nexus.
        """
        updates_applied: list[dict] = []

        # --- Apply feedback to knowledge graph ---
        if event_type == "code_accepted":
            self.increment_persona_stats(tenant_id, user_id, accepted=True)
            updates_applied.append({"table": "user_persona", "field": "total_accepted", "action": "increment"})

        elif event_type == "code_rejected":
            self.increment_persona_stats(tenant_id, user_id, accepted=False)
            reason = feedback.get("reason", "")
            if reason:
                self.record_decision(tenant_id, user_id, prompt or "code generation", "failed", reason)
            updates_applied.append({"table": "user_persona", "field": "total_rejected", "action": "increment"})

        elif event_type == "preference_stated":
            key = feedback.get("key", "")
            value = feedback.get("value", "")
            if key and value:
                self.update_persona_preference(tenant_id, user_id, key, value)
                updates_applied.append({"table": "user_persona", "field": f"preferences.{key}", "value": value})

        elif event_type == "library_preference":
            lib_name = feedback.get("library", "")
            lib_choice = feedback.get("choice", "")
            if lib_name and lib_choice:
                self.update_persona_preference(tenant_id, user_id, f"library_prefs.{lib_name}", lib_choice)
                updates_applied.append({"table": "user_persona", "field": f"preferences.library_prefs.{lib_name}", "value": lib_choice})

        elif event_type == "style_correction":
            pattern = feedback.get("pattern", "")
            if pattern:
                persona = self._get_or_create_persona(tenant_id, user_id)
                dislikes = persona.get("preferences", {}).get("dislikes", [])
                if not isinstance(dislikes, list):
                    dislikes = []
                if pattern not in dislikes:
                    dislikes.append(pattern)
                    self.update_persona_preference(tenant_id, user_id, "dislikes", dislikes)
                updates_applied.append({"table": "user_persona", "field": "preferences.dislikes", "action": "append"})

        elif event_type == "tech_debt_tagged":
            file = feedback.get("file", "")
            severity = feedback.get("severity", "medium")
            description = feedback.get("description", "")
            if file and description:
                self.tag_tech_debt(project_id, file, severity, description, agent or "user")
                updates_applied.append({"table": "project_state_matrix", "field": "tech_debt", "action": "append"})

        elif event_type == "architecture_decision":
            decision = feedback.get("decision", "")
            if decision:
                self.record_decision(tenant_id, user_id, decision, "success")
                updates_applied.append({"table": "user_persona", "field": "history", "action": "append"})

        # --- Store the feedback event ---
        try:
            self.db.table("nexus_feedback").insert({
                "id": str(uuid4()),
                "tenant_id": tenant_id,
                "project_id": project_id,
                "user_id": user_id,
                "event_type": event_type,
                "agent": agent,
                "prompt": prompt,
                "response_summary": response_summary,
                "feedback": feedback,
                "updates_applied": updates_applied,
            }).execute()
        except Exception as e:
            logger.warning("Failed to record feedback: %s", e)

    # -----------------------------------------------------------------------
    # Agent Execution Tracking
    # -----------------------------------------------------------------------

    def start_agent_execution(
        self,
        tenant_id: str,
        project_id: str,
        build_id: str | None,
        agent_role: str,
        agent_step: str,
        model_tier: str,
        model_id: str | None = None,
        input_summary: str | None = None,
    ) -> str:
        """Record the start of an agent execution. Returns execution ID."""
        exec_id = str(uuid4())
        try:
            self.db.table("agent_executions").insert({
                "id": exec_id,
                "tenant_id": tenant_id,
                "project_id": project_id,
                "build_id": build_id,
                "agent_role": agent_role,
                "agent_step": agent_step,
                "model_tier": model_tier,
                "model_id": model_id,
                "input_summary": input_summary,
                "status": "running",
            }).execute()
        except Exception as e:
            logger.warning("Failed to start agent execution: %s", e)
        return exec_id

    def complete_agent_execution(
        self,
        execution_id: str,
        status: str,
        output_summary: str | None = None,
        output_artifact: dict | None = None,
        tokens_in: int = 0,
        tokens_out: int = 0,
        cost_usd: float = 0.0,
        latency_ms: int = 0,
        error: str | None = None,
    ) -> None:
        """Record the completion of an agent execution."""
        try:
            self.db.table("agent_executions").update({
                "status": status,
                "output_summary": output_summary,
                "output_artifact": output_artifact,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "cost_usd": cost_usd,
                "latency_ms": latency_ms,
                "error": error,
                "completed_at": datetime.now(timezone.utc).isoformat(),
            }).eq("id", execution_id).execute()
        except Exception as e:
            logger.warning("Failed to complete agent execution: %s", e)

    def get_agent_activity(
        self,
        project_id: str,
        limit: int = 20,
    ) -> list[dict]:
        """Get recent agent activity for the project."""
        try:
            result = (
                self.db.table("agent_executions")
                .select("*")
                .eq("project_id", project_id)
                .order("started_at", desc=True)
                .limit(limit)
                .execute()
            )
            return result.data or []
        except Exception as e:
            logger.warning("Failed to get agent activity: %s", e)
            return []

    # -----------------------------------------------------------------------
    # Full Nexus State (for dashboard)
    # -----------------------------------------------------------------------

    def get_full_state(
        self,
        tenant_id: str,
        project_id: str,
        user_id: str,
    ) -> dict:
        """Get the full Neural Nexus state for the dashboard."""
        persona = self._get_or_create_persona(tenant_id, user_id)
        psm = self._get_or_create_psm(tenant_id, project_id)
        bl = self._get_business_logic(project_id)
        feedback = self._get_recent_feedback(project_id, user_id, limit=20)
        activity = self.get_agent_activity(project_id, limit=20)

        return {
            "user_persona": {
                "preferences": persona.get("preferences", {}),
                "expertise": persona.get("expertise", {}),
                "history": persona.get("history", [])[-10:],
                "stats": {
                    "total_prompts": persona.get("total_prompts", 0),
                    "total_accepted": persona.get("total_accepted", 0),
                    "total_rejected": persona.get("total_rejected", 0),
                    "acceptance_rate": float(persona.get("acceptance_rate", 0)),
                },
            },
            "project_state": {
                "file_graph": psm.get("file_graph", {}),
                "dependency_graph": psm.get("dependency_graph", {}),
                "tech_debt": psm.get("tech_debt", []),
                "health_score": psm.get("health_score", 100),
                "last_analyzed_at": psm.get("last_analyzed_at"),
            },
            "business_logic": [
                {
                    "entity_type": bl_entry.get("entity_type"),
                    "entity_path": bl_entry.get("entity_path"),
                    "entity_name": bl_entry.get("entity_name"),
                    "purpose": bl_entry.get("purpose"),
                    "domain": bl_entry.get("domain"),
                    "confidence": float(bl_entry.get("confidence", 0.5)),
                }
                for bl_entry in bl[:20]
            ],
            "recent_feedback": [
                {
                    "event_type": fb.get("event_type"),
                    "agent": fb.get("agent"),
                    "feedback": fb.get("feedback"),
                    "created_at": fb.get("created_at"),
                }
                for fb in feedback
            ],
            "agent_activity": [
                {
                    "id": a.get("id"),
                    "agent_role": a.get("agent_role"),
                    "agent_step": a.get("agent_step"),
                    "model_tier": a.get("model_tier"),
                    "status": a.get("status"),
                    "tokens_in": a.get("tokens_in", 0),
                    "tokens_out": a.get("tokens_out", 0),
                    "cost_usd": float(a.get("cost_usd", 0)),
                    "latency_ms": a.get("latency_ms", 0),
                    "input_summary": a.get("input_summary"),
                    "output_summary": a.get("output_summary"),
                    "started_at": a.get("started_at"),
                    "completed_at": a.get("completed_at"),
                }
                for a in activity
            ],
        }


# ============================================================================
# Static analysis helpers (lightweight, no AST library needed)
# ============================================================================

def _classify_file(path: str, content: str) -> str:
    """Classify a file by its type."""
    if path.endswith((".tsx", ".jsx")):
        if "export default function" in content or "export default class" in content:
            return "react_component"
        if re.search(r"export\s+function\s+\w+.*\(.*request", content):
            return "api_route"
        return "react_module"
    if path.endswith((".ts", ".js")):
        if "createClient" in content or "supabase" in content.lower():
            return "database_client"
        if re.search(r"export\s+(async\s+)?function", content):
            return "utility"
        return "module"
    if path.endswith(".css"):
        return "stylesheet"
    if path.endswith(".json"):
        return "config"
    return "other"


def _extract_imports(content: str) -> list[str]:
    """Extract import statements."""
    imports = []
    for match in re.finditer(r'import\s+.*?from\s+["\'](.+?)["\']', content):
        imports.append(match.group(1))
    return imports


def _extract_exports(content: str) -> list[str]:
    """Extract export names."""
    exports = []
    for match in re.finditer(r'export\s+(?:default\s+)?(?:function|class|const|let|var)\s+(\w+)', content):
        exports.append(match.group(1))
    return exports


def _extract_hooks(content: str) -> list[str]:
    """Extract React hooks used."""
    hooks = set()
    for match in re.finditer(r'\buse[A-Z]\w+', content):
        hooks.add(match.group(0))
    return sorted(hooks)


def _estimate_complexity(content: str) -> str:
    """Estimate file complexity: low, medium, high."""
    lines = content.count("\n") + 1
    conditionals = len(re.findall(r'\b(if|else|switch|case|catch)\b', content))
    loops = len(re.findall(r'\b(for|while|\.map|\.reduce|\.filter)\b', content))

    score = lines / 50 + conditionals / 3 + loops / 2

    if score > 10:
        return "high"
    if score > 4:
        return "medium"
    return "low"
