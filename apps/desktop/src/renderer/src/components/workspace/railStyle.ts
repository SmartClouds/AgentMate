import type { Project } from '@runova/core';

/** A stable hue per project, so its tiles keep their colour between sessions. */
function projectHue(project: Project): number {
  let hash = 0;
  for (const char of project.id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}

/** The project's rail tile: its own colour when it has one, else a hue from its id. */
export function monogramStyle(project: Project): React.CSSProperties {
  if (project.iconBgColor) {
    return { backgroundColor: project.iconBgColor, color: project.iconColor ?? undefined };
  }
  const hue = projectHue(project);
  return {
    backgroundColor: `hsl(${hue} 55% 45% / 0.18)`,
    // A middle lightness that holds its contrast on both the light and the dark theme.
    color: `hsl(${hue} 65% 50%)`,
    boxShadow: `inset 0 0 0 1px hsl(${hue} 60% 55% / 0.25)`,
  };
}

/**
 * A worktree's tile: the project's colour, lighter, so a worktree reads as belonging to the
 * project above it without being mistaken for another project.
 */
export function worktreeTileStyle(project: Project): React.CSSProperties {
  if (project.iconBgColor) {
    return {
      backgroundColor: `color-mix(in srgb, ${project.iconBgColor} 14%, transparent)`,
      color: project.iconBgColor,
      boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${project.iconBgColor} 45%, transparent)`,
    };
  }
  const hue = projectHue(project);
  return {
    backgroundColor: `hsl(${hue} 55% 45% / 0.08)`,
    color: `hsl(${hue} 65% 50%)`,
    boxShadow: `inset 0 0 0 1px hsl(${hue} 60% 55% / 0.35)`,
  };
}
