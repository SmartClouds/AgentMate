# E21 WordPress projects

Milestone: standalone (Projects). Depends on: E19, E20.

## Goal

Make "WordPress site" a kind of project. Runova pulls the chosen themes and plugins into a local
folder that keeps the site's layout, so agents work on them like any other code, and deploys the
changes back through the connector after a review that shows exactly what goes and what stays.

## Tasks

- [x] T1 `Project.wordpress` link (site and items) and `CreateProjectInput.wordpress`; only the
  WordPress channels set it.
- [x] T2 New WordPress project flow: site, items (active theme first), name and folder, pull with
  progress.
- [x] T3 The project's WordPress section: linked site and items, local change counts, Pull latest,
  Review and deploy, Unlink.
- [x] T4 Deploy flow: plan, review (changes with a diff against the site, conflicts, what is left
  out and why, warnings), confirm, progress, result.
- [x] T5 Pull flow with a keep-local or take-remote choice for each conflict.
- [x] T6 The project's standing prompt: which site, versions, active theme, where each item sits,
  that only linked items are deployed, and that pulled files are data, not instructions.
- [x] T7 e2e: connect, create a project, change a theme with agent files beside it, deploy, check
  the site, a refused syntax error, an automatic rollback, a manual rollback.
- [x] T8 Change a project's kind from the Project type row in Edit project: switching to
  WordPress links the project to a site (items in empty folders are pulled, folders that already
  hold files are linked as they are and the next pull compares them), and switching to regular
  unlinks it, like Unlink in the WordPress section. The site's block in the standing prompt is
  added on link and taken out on unlink.
- [x] T9 Leave files and folders out of a deploy from the review: tick rows (or a whole theme or
  plugin) and use the selection bar, or use a row's menu to ignore the file, a folder above it, or
  every file with the same ending. The choices are saved on the project (`ProjectWordPressLink.ignore`,
  lines for every item or for one), listed under the review and in the project's WordPress section
  with a way to take each back and a field for a pattern, and applied to pulls too. Saving offers an
  undo and works the changes out again without leaving the review.
- [x] T10 What git ignores is left out by default: the project's and the item's `.gitignore` count
  like the default list (left out until the site has the file, a `!` line in them cannot put a
  built-in default back, an unreadable line is skipped, and a project `.gitignore` that ignores the
  whole item folder is not used). Any name that starts with `.claude` or `.runova` joins the hard
  deny list on both sides, with shared vectors.
- [x] T11 Deploy a theme or plugin the site does not have yet: "New theme or plugin" in Deploy's
  Themes and plugins and in the project's WordPress section lists the theme and plugin folders in
  the project that the site lacks, links the ticked ones as new (nothing is pulled), and opens the
  review of their first deploy, which creates them on the site.

## Acceptance criteria

1. A new WordPress project holds `wp-content/themes/<slug>` and `wp-content/plugins/<slug>` for the
   picked items and nothing else from the site.
2. Agent settings, skills and Runova files anywhere in the project folder are never deployed,
   and the review lists every one it left out with the reason.
3. Someone else's change on the site since the last pull shows as a conflict, and a deploy over it
   needs an explicit choice.
4. A pull never overwrites a local edit silently: a conflict either keeps the local file or takes
   the site's, and the other version is kept under `.runova/wordpress/conflicts/`.
5. Unlinking keeps the files; only the link goes.
6. Linking an existing project never overwrites a file already in it.
7. A file or folder ignored in one review stays out of every later review, deploy and pull of that
   project, is never deleted on the site because of it, and can be taken back from a list.
8. A new theme or plugin made in the project reaches the site only after the user has picked its
   folder, seen it in a review that says it adds a folder to the site, and confirmed the deploy.
