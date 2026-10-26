import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { Project } from '@runova/core';
import { Command as CommandPrimitive } from 'cmdk';
import { useState } from 'react';
import { Check, Plus, Search, X } from '@/components/icons';
import { ProjectIcon } from '@/components/projects/ProjectIcon';
import { FIELD_SURFACE } from '@/components/ui/input';
import { LIST_OPTION, LIST_SEARCH, OVERLAY_MOTION, OVERLAY_SURFACE } from '@/components/ui/overlay';
import { cn } from '@/lib/utils';

export interface ProjectMultiPickerProps {
  value: string[];
  onChange: (ids: string[]) => void;
  projects: Project[];
  /** Lets a `<Label htmlFor>` name the list button, the way it names an input. */
  id?: string;
  /** What the field is, for screen readers, when no visible label points at it. */
  ariaLabel?: string;
  ariaDescribedBy?: string;
  disabled?: boolean;
}

/**
 * Picks any number of projects. The chosen ones sit in the field as chips with a remove button,
 * and the list searches by name or folder and ticks rows on and off without closing, so attaching
 * three projects is three clicks. Archived projects stay out of the list unless already chosen.
 */
export function ProjectMultiPicker({
  value,
  onChange,
  projects,
  id,
  ariaLabel,
  ariaDescribedBy,
  disabled,
}: ProjectMultiPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const chosen = new Set(value);
  const byId = new Map(projects.map((project) => [project.id, project]));
  const listed = projects.filter((project) => !project.archived || chosen.has(project.id));

  function toggle(projectId: string): void {
    onChange(
      chosen.has(projectId) ? value.filter((one) => one !== projectId) : [...value, projectId],
    );
  }

  return (
    <div
      className={cn(
        FIELD_SURFACE,
        'flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-2xl py-1 pl-1.5 pr-1',
        disabled && 'opacity-50',
      )}
    >
      {value.length === 0 ? (
        <span className="px-2 text-sm text-muted-foreground">No projects attached</span>
      ) : (
        value.map((projectId) => {
          const project = byId.get(projectId);
          const name = project?.name ?? 'Removed project';
          return (
            <span
              key={projectId}
              className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-foreground/[0.06] pl-1 pr-0.5 text-xs font-medium"
            >
              <ProjectIcon
                iconDataUrl={project?.iconDataUrl ?? null}
                bgColor={project?.iconBgColor}
                iconColor={project?.iconColor}
                className="h-5 w-5 rounded-full"
                glyphClassName="h-2.5 w-2.5"
              />
              <span className="truncate">{name}</span>
              <button
                type="button"
                aria-label={`Remove ${name}`}
                disabled={disabled}
                onClick={() => toggle(projectId)}
                className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          );
        })
      )}
      <PopoverPrimitive.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setSearch('');
        }}
      >
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            id={id}
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-label={ariaLabel}
            aria-describedby={ariaDescribedBy}
            disabled={disabled}
            className="ml-auto inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
          >
            <Plus className="h-3 w-3" />
            {value.length === 0 ? 'Attach' : 'Change'}
          </button>
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            align="end"
            sideOffset={6}
            collisionPadding={8}
            className={cn(
              OVERLAY_SURFACE,
              OVERLAY_MOTION,
              'z-50 w-80 max-w-[calc(100vw-2rem)] overflow-hidden origin-[var(--radix-popover-content-transform-origin)]',
            )}
          >
            <CommandPrimitive className="flex flex-col" filter={cmdkFilter}>
              <div className="p-1 pb-0">
                <div className={LIST_SEARCH}>
                  <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <CommandPrimitive.Input
                    autoFocus
                    value={search}
                    onValueChange={setSearch}
                    placeholder="Search projects…"
                    className="h-full w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
                  />
                </div>
              </div>
              <CommandPrimitive.List className="rail-scroll max-h-64 overflow-y-auto p-1">
                <CommandPrimitive.Empty className="py-6 text-center text-sm text-muted-foreground">
                  {projects.length === 0 ? 'No projects yet.' : 'No project matches.'}
                </CommandPrimitive.Empty>
                {listed.map((project) => {
                  const checked = chosen.has(project.id);
                  return (
                    <CommandPrimitive.Item
                      key={project.id}
                      value={`${project.name} ${project.folderPath} ${project.id}`}
                      onSelect={() => toggle(project.id)}
                      data-checked={checked}
                      className={LIST_OPTION}
                    >
                      {/* Drawn, not a real checkbox: the row's own select toggles it, once. */}
                      <span
                        aria-hidden
                        className={cn(
                          'flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border-[1.5px] transition-colors',
                          checked
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-foreground/30 bg-foreground/5',
                        )}
                      >
                        {checked && <Check className="h-2.5 w-2.5" />}
                      </span>
                      <ProjectIcon
                        iconDataUrl={project.iconDataUrl}
                        bgColor={project.iconBgColor}
                        iconColor={project.iconColor}
                        className="h-6 w-6 rounded-md"
                        glyphClassName="h-3 w-3"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{project.name}</span>
                        <span className="block truncate font-mono text-[10px] text-muted-foreground">
                          {project.folderPath}
                        </span>
                      </span>
                      <span className="sr-only">{checked ? ', attached' : ''}</span>
                    </CommandPrimitive.Item>
                  );
                })}
              </CommandPrimitive.List>
            </CommandPrimitive>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    </div>
  );
}

function cmdkFilter(value: string, search: string): number {
  return value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0;
}
