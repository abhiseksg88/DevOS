/**
 * Public Deployment Route: /p/[slug]
 *
 * Serves generated apps as public URLs with no authentication required.
 * Example: /p/meal-planner-x9z renders the Meal Planner app stored in projects.code_files
 *
 * Users can share these URLs with anyone to let them interact with the deployed app.
 * App data is persisted to Supabase app_data table, so all users share the same data.
 */

import { createClient } from "@/lib/supabase/server";
import { PreviewPane } from "@/components/preview/PreviewPane";
import type { FileNode } from "@/types";

export default async function DeploymentPage({ params }: { params: { slug: string } }) {
  const supabase = createClient();

  // Fetch the project by slug (public, no auth required)
  const { data: project, error } = await supabase
    .from("projects")
    .select("id, name, code_files")
    .eq("slug", params.slug)
    .single();

  if (error || !project) {
    return (
      <div className="w-screen h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-950">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-foreground mb-2">App Not Found</h1>
          <p className="text-slate-400 mb-6">The app with slug "{params.slug}" doesn't exist.</p>
          <a
            href="/"
            className="inline-block px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Back to Home
          </a>
        </div>
      </div>
    );
  }

  // Convert code map to file tree
  const codeFiles = (project.code_files ?? {}) as Record<string, string>;
  const fileTree = codeMapToTree(codeFiles);

  return (
    <div className="w-screen h-screen bg-white">
      <PreviewPane url={null} files={fileTree} />
    </div>
  );
}

// Helper: Convert code map (flat) to file tree (nested)
function codeMapToTree(codeFiles: Record<string, string>): FileNode[] {
  const tree: FileNode[] = [];

  for (const [path, content] of Object.entries(codeFiles)) {
    const parts = path.split("/");
    addToTree(tree, parts, 0, content);
  }

  return tree;
}

// Recursively add a file to the tree, creating directories as needed
function addToTree(tree: FileNode[], parts: string[], index: number, content: string): void {
  if (index >= parts.length) return;

  const part = parts[index];
  const isFile = index === parts.length - 1;
  const fullPath = parts.slice(0, index + 1).join("/");

  let node = tree.find((n) => n.name === part);

  if (!node) {
    const ext = part.split(".").pop() ?? "";
    const langMap: Record<string, string> = {
      tsx: "typescriptreact",
      jsx: "javascriptreact",
      ts: "typescript",
      js: "javascript",
      css: "css",
      json: "json",
      html: "html",
      md: "markdown",
    };

    node = {
      name: part,
      path: fullPath,
      type: isFile ? "file" : "directory",
      ...(isFile && {
        language: langMap[ext] ?? "plaintext",
        content,
      }),
      ...(isFile ? {} : { children: [] }),
    };

    tree.push(node);
  }

  if (!isFile && node.children) {
    addToTree(node.children, parts, index + 1, content);
  } else if (isFile) {
    node.content = content;
  }
}
