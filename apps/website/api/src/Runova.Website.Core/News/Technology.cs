using System.Collections.Frozen;

namespace Runova.Website.Core.News;

/// <summary>
/// A technology a news item can name, from the contract's technology table. The slugs of the AI
/// CLIs are the ids in packages/core/src/cli/registry.ts, so the desktop app matches them directly.
/// </summary>
public sealed class Technology
{
    public long Id { get; init; }

    public required string Slug { get; init; }

    public required string Name { get; init; }

    public TechnologyKind Kind { get; init; }

    /// <summary>The desktop app can read the installed version and match it against a range.</summary>
    public bool Detectable { get; init; }
}

/// <summary>
/// The technology list, in the contract's order. A migration seeds it from here, so changing it
/// needs a new migration, and a unit test fails when it drifts from the contract.
/// </summary>
public static class Technologies
{
    public static IReadOnlyList<Technology> All { get; } =
    [
        new() { Id = 1, Slug = "runova", Name = "Runova", Kind = TechnologyKind.App, Detectable = true },
        new() { Id = 2, Slug = "electron", Name = "Electron", Kind = TechnologyKind.Runtime, Detectable = true },
        new() { Id = 3, Slug = "nodejs", Name = "Node.js", Kind = TechnologyKind.Runtime, Detectable = true },
        new() { Id = 4, Slug = "git", Name = "Git", Kind = TechnologyKind.Tool, Detectable = true },
        new() { Id = 5, Slug = "dotnet", Name = ".NET", Kind = TechnologyKind.Runtime, Detectable = true },
        new() { Id = 6, Slug = "docker", Name = "Docker", Kind = TechnologyKind.Tool, Detectable = true },
        new() { Id = 7, Slug = "claude-code", Name = "Claude Code", Kind = TechnologyKind.AiCli, Detectable = true },
        new() { Id = 8, Slug = "codex-cli", Name = "Codex CLI", Kind = TechnologyKind.AiCli, Detectable = true },
        new() { Id = 9, Slug = "gemini-cli", Name = "Gemini CLI", Kind = TechnologyKind.AiCli, Detectable = true },
        new() { Id = 10, Slug = "grok-cli", Name = "Grok CLI", Kind = TechnologyKind.AiCli, Detectable = true },
        new() { Id = 11, Slug = "cursor-cli", Name = "Cursor CLI", Kind = TechnologyKind.AiCli, Detectable = true },
        new() { Id = 12, Slug = "opencode", Name = "OpenCode", Kind = TechnologyKind.AiCli, Detectable = true },
        new() { Id = 13, Slug = "openclaude", Name = "OpenClaude", Kind = TechnologyKind.AiCli, Detectable = true },
        new() { Id = 14, Slug = "copilot-cli", Name = "GitHub Copilot CLI", Kind = TechnologyKind.AiCli, Detectable = true },
        new() { Id = 15, Slug = "aider", Name = "Aider", Kind = TechnologyKind.AiCli, Detectable = true },
        new() { Id = 16, Slug = "goose", Name = "Goose", Kind = TechnologyKind.AiCli, Detectable = true },
        new() { Id = 17, Slug = "cline-cli", Name = "Cline CLI", Kind = TechnologyKind.AiCli, Detectable = true },
        new() { Id = 18, Slug = "continue-cli", Name = "Continue CLI", Kind = TechnologyKind.AiCli, Detectable = true },
        new() { Id = 19, Slug = "pi", Name = "Pi", Kind = TechnologyKind.AiCli, Detectable = true },
        new() { Id = 20, Slug = "muse-code", Name = "Muse Code", Kind = TechnologyKind.AiCli, Detectable = true },
        new() { Id = 21, Slug = "freebuff-cli", Name = "FreeBuff", Kind = TechnologyKind.AiCli, Detectable = true },
        new() { Id = 22, Slug = "qwen-cli", Name = "Qwen Code", Kind = TechnologyKind.AiCli, Detectable = true },
        new() { Id = 23, Slug = "python", Name = "Python", Kind = TechnologyKind.Runtime, Detectable = false },
        new() { Id = 24, Slug = "bun", Name = "Bun", Kind = TechnologyKind.Runtime, Detectable = false },
        new() { Id = 25, Slug = "deno", Name = "Deno", Kind = TechnologyKind.Runtime, Detectable = false },
        new() { Id = 26, Slug = "java", Name = "Java", Kind = TechnologyKind.Runtime, Detectable = false },
        new() { Id = 27, Slug = "go", Name = "Go", Kind = TechnologyKind.Runtime, Detectable = false },
        new() { Id = 28, Slug = "rust", Name = "Rust", Kind = TechnologyKind.Runtime, Detectable = false },
        new() { Id = 29, Slug = "php", Name = "PHP", Kind = TechnologyKind.Runtime, Detectable = false },
        new() { Id = 30, Slug = "npm", Name = "npm", Kind = TechnologyKind.Tool, Detectable = false },
        new() { Id = 31, Slug = "pnpm", Name = "pnpm", Kind = TechnologyKind.Tool, Detectable = false },
        new() { Id = 32, Slug = "typescript", Name = "TypeScript", Kind = TechnologyKind.Tool, Detectable = false },
        new() { Id = 33, Slug = "vscode", Name = "Visual Studio Code", Kind = TechnologyKind.Tool, Detectable = false },
        new() { Id = 34, Slug = "github-actions", Name = "GitHub Actions", Kind = TechnologyKind.Service, Detectable = false },
        new() { Id = 35, Slug = "android-sdk", Name = "Android SDK", Kind = TechnologyKind.Tool, Detectable = false },
        new() { Id = 36, Slug = "flutter", Name = "Flutter", Kind = TechnologyKind.Tool, Detectable = false },
        new() { Id = 37, Slug = "openssh", Name = "OpenSSH", Kind = TechnologyKind.Server, Detectable = false },
        new() { Id = 38, Slug = "openssl", Name = "OpenSSL", Kind = TechnologyKind.Library, Detectable = false },
        new() { Id = 39, Slug = "nginx", Name = "nginx", Kind = TechnologyKind.Server, Detectable = false },
        new() { Id = 40, Slug = "postgresql", Name = "PostgreSQL", Kind = TechnologyKind.Server, Detectable = false },
        new() { Id = 41, Slug = "mysql", Name = "MySQL", Kind = TechnologyKind.Server, Detectable = false },
        new() { Id = 42, Slug = "redis", Name = "Redis", Kind = TechnologyKind.Server, Detectable = false },
        new() { Id = 43, Slug = "wordpress", Name = "WordPress", Kind = TechnologyKind.App, Detectable = false },
        new() { Id = 44, Slug = "kubernetes", Name = "Kubernetes", Kind = TechnologyKind.Server, Detectable = false },
        new() { Id = 45, Slug = "linux-kernel", Name = "Linux kernel", Kind = TechnologyKind.Os, Detectable = false },
        new() { Id = 46, Slug = "ubuntu", Name = "Ubuntu", Kind = TechnologyKind.Os, Detectable = false },
        new() { Id = 47, Slug = "debian", Name = "Debian", Kind = TechnologyKind.Os, Detectable = false },
        new() { Id = 48, Slug = "rocky-linux", Name = "Rocky Linux", Kind = TechnologyKind.Os, Detectable = false },
        new() { Id = 49, Slug = "windows", Name = "Windows", Kind = TechnologyKind.Os, Detectable = false },
        new() { Id = 50, Slug = "macos", Name = "macOS", Kind = TechnologyKind.Os, Detectable = false },
    ];

    private static readonly FrozenDictionary<string, Technology> _bySlug =
        All.ToFrozenDictionary(t => t.Slug, StringComparer.Ordinal);

    /// <summary>The technology with this exact slug, or null.</summary>
    public static Technology? Find(string slug) => _bySlug.GetValueOrDefault(slug);
}
