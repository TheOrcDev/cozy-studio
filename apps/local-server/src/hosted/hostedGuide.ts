import contract from '../../../../docs/agents/mcp.md' with { type: 'text' };
import overview from '../../../../skills/cozy-studio-mcp/SKILL.md' with { type: 'text' };
import configure from '../../../../skills/cozy-studio-mcp/references/configure.md' with { type: 'text' };
import generateAndCompare from '../../../../skills/cozy-studio-mcp/references/generate-and-compare.md' with { type: 'text' };
import hosted from '../../../../skills/cozy-studio-mcp/references/hosted.md' with { type: 'text' };
import maintenanceAndCleanup from '../../../../skills/cozy-studio-mcp/references/maintenance-and-cleanup.md' with { type: 'text' };
import organizeLibrary from '../../../../skills/cozy-studio-mcp/references/organize-library.md' with { type: 'text' };
import setupAndRepair from '../../../../skills/cozy-studio-mcp/references/setup-and-repair.md' with { type: 'text' };
import stylesAndPacks from '../../../../skills/cozy-studio-mcp/references/styles-and-packs.md' with { type: 'text' };
import troubleshooting from '../../../../skills/cozy-studio-mcp/references/troubleshooting.md' with { type: 'text' };
import workflowsAndRecipes from '../../../../skills/cozy-studio-mcp/references/workflows-and-recipes.md' with { type: 'text' };
import workspaces from '../../../../skills/cozy-studio-mcp/references/workspaces.md' with { type: 'text' };

// The cozy-studio-mcp skill for the hosted studio_guide (ADR 0013). A Neon Function has no
// checkout to read, so esbuild inlines each file. Only the Neon entry imports this module: Vitest
// cannot load Markdown as text. hostedGuide.test.ts checks that every reference is listed here.
export const HOSTED_GUIDE: Record<string, string> = {
  overview,
  contract,
  hosted,
  configure,
  'generate-and-compare': generateAndCompare,
  'maintenance-and-cleanup': maintenanceAndCleanup,
  'organize-library': organizeLibrary,
  'setup-and-repair': setupAndRepair,
  'styles-and-packs': stylesAndPacks,
  troubleshooting,
  'workflows-and-recipes': workflowsAndRecipes,
  workspaces,
};
