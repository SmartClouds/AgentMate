using Microsoft.Extensions.Logging.Abstractions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Platform;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests;

/// <summary>A job context over a real log file, for testing the work a job does without an engine.</summary>
internal sealed class TestJob : IDisposable
{
    private readonly string _directory = TestFolders.Create("core-job");
    private readonly JobLogWriter _log;

    public TestJob(JobKind kind = JobKind.PackagesUpgrade)
    {
        Directory.CreateDirectory(_directory);
        _log = JobLogWriter.Create(Path.Combine(_directory, "job.log"), JobEngine.DefaultMaxLogBytes, TimeProvider.System, () => { });
        Context = new JobContext(Id, kind, _log, new Redactor());
    }

    public Guid Id { get; } = Guid.NewGuid();

    public JobContext Context { get; }

    public async Task<List<JobLogLine>> LinesAsync()
    {
        using var reader = new JobLogReader(Path.Combine(_directory, "job.log"));
        return await reader.ReadNewAsync(TestContext.Current.CancellationToken);
    }

    public void Dispose()
    {
        _log.Dispose();
        TestFolders.Delete(_directory);
    }
}

/// <summary>A copy of a fixture host (or an empty root) that tests may write into.</summary>
internal sealed class TestRoot : IDisposable
{
    public TestRoot(string? host = null)
    {
        Path = TestFolders.Create("core-root");
        Directory.CreateDirectory(Path);
        if (host is not null)
        {
            Copy(Fixtures.Host(host), Path);
        }

        Files = new SystemFiles(Path);
    }

    public string Path { get; }

    public SystemFiles Files { get; }

    public void Write(string systemPath, string content)
    {
        var target = Resolve(systemPath);
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(target)!);
        File.WriteAllText(target, content);
    }

    public string Resolve(string systemPath) =>
        System.IO.Path.Combine(Path, systemPath.TrimStart('/').Replace('/', System.IO.Path.DirectorySeparatorChar));

    public void Dispose() => TestFolders.Delete(Path);

    private static void Copy(string from, string to)
    {
        foreach (var directory in Directory.EnumerateDirectories(from, "*", SearchOption.AllDirectories))
        {
            Directory.CreateDirectory(directory.Replace(from, to, StringComparison.Ordinal));
        }

        foreach (var file in Directory.EnumerateFiles(from, "*", SearchOption.AllDirectories))
        {
            File.Copy(file, file.Replace(from, to, StringComparison.Ordinal));
        }
    }
}

internal static class Units
{
    public static SystemdRunner Runner(FakeProcessRunner processes) =>
        new(processes, TimeProvider.System, NullLogger<SystemdRunner>.Instance);

    public static bool IsUnitRun(ProcessSpec spec) => Path.GetFileName(spec.Program) == "systemd-run";

    /// <summary>The command a systemd-run call starts in its unit, after the `--`.</summary>
    public static string[] Command(ProcessSpec spec) => [.. spec.Arguments.SkipWhile(a => a != "--").Skip(1)];

    public static string[] Environment(ProcessSpec spec) =>
        [.. spec.Arguments.Where(a => a.StartsWith("--setenv=", StringComparison.Ordinal)).Select(a => a["--setenv=".Length..])];

    public static string? UnitName(ProcessSpec spec) =>
        spec.Arguments.FirstOrDefault(a => a.StartsWith("--unit=", StringComparison.Ordinal))?["--unit=".Length..];
}
