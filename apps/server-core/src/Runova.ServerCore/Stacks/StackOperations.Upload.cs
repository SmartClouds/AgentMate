using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Registries;
using Runova.ServerCore.Uploads;

namespace Runova.ServerCore.Stacks;

/// <summary>
/// Uploads: a revision's compose file and .env (and, when announced, its build context), written
/// root-only into a folder of its own, then checked with docker compose config. Compose's reading
/// of the files holds env values, so it is linted in memory and dropped; only the services, the
/// findings and the bindings are kept.
/// </summary>
internal sealed partial class StackOperations
{
    public const int MaxComposeBytes = 1024 * 1024;

    public static readonly TimeSpan ConfigTimeout = TimeSpan.FromSeconds(60);

    private const int MaxConfigOutputBytes = 16 * 1024 * 1024;

    private const int MaxErrorLength = 1_500;

    private const UnixFileMode PrivateFile = UnixFileMode.UserRead | UnixFileMode.UserWrite;

    private const UnixFileMode PrivateFolder = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;

    public async Task<StackRevisionInfo> UploadAsync(Guid stackId, StackRevisionUpload? upload, StackCaller caller, CancellationToken cancellationToken)
    {
        var stack = await StackAsync(stackId, cancellationToken);
        string problem;
        if ((problem = CheckUpload(upload)) is { Length: > 0 })
        {
            await AuditAsync("stack.revision-upload", AuditResult.Denied, caller, stack.Name, new() { ["reason"] = problem }, cancellationToken);
            throw new StackRefusedException(problem);
        }

        var env = ComposeEnvFile.Parse(upload!.Env);
        if (!env.Ok)
        {
            await AuditAsync("stack.revision-upload", AuditResult.Denied, caller, stack.Name, new() { ["reason"] = env.Problem }, cancellationToken);
            throw new StackRefusedException(env.Problem!);
        }

        CheckSource(upload.Source);
        StackRevisionRecord row;
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await using var db = await contexts.CreateDbContextAsync(cancellationToken);
            var tracked = await db.Stacks.FirstOrDefaultAsync(s => s.Id == stackId, cancellationToken)
                ?? throw new StackRefusedException("There is no such app.", StatusCodes.Status404NotFound);
            var number = tracked.LastRevision + 1;
            var folder = RevisionFolder(stackId, number);
            if (Directory.Exists(folder))
            {
                Directory.Delete(folder, recursive: true);
            }

            directories.EnsureStacks();
            CreatePrivateFolder(StackFolder(stackId));
            CreatePrivateFolder(Path.Combine(StackFolder(stackId), "revisions"));
            CreatePrivateFolder(folder);
            var composeBytes = Encoding.UTF8.GetBytes(upload.Compose);
            await WritePrivateAsync(Path.Combine(folder, ComposeFileName), composeBytes, cancellationToken);
            await WritePrivateAsync(Path.Combine(folder, EnvFileName), Encoding.UTF8.GetBytes(upload.Env), cancellationToken);
            if (!upload.BuildContext)
            {
                CreatePrivateFolder(Path.Combine(folder, FilesFolder));
            }

            var acknowledged = upload.AcknowledgedRisks.Distinct(StringComparer.Ordinal).ToArray();
            row = new StackRevisionRecord
            {
                StackId = stackId,
                Number = number,
                State = upload.BuildContext ? nameof(StackRevisionState.AwaitingContext) : nameof(StackRevisionState.Ready),
                CreatedAt = Now,
                CreatedBy = caller.UserName,
                ComposeSha256 = Convert.ToHexStringLower(SHA256.HashData(composeBytes)),
                EnvKeys = Write(env.Entries.Select(e => e.Key).Distinct(StringComparer.Ordinal).ToArray()),
                ProxiedServices = Write(upload.ProxiedServices.Distinct(StringComparer.Ordinal).ToArray()),
                AcknowledgedRisks = Write(acknowledged),
                HasBuildContext = upload.BuildContext,
                ProjectId = upload.Source?.ProjectId,
                ProjectName = upload.Source?.ProjectName,
                ComposePath = upload.Source?.ComposePath,
                EnvironmentId = upload.Source?.EnvironmentId,
                EnvironmentName = upload.Source?.EnvironmentName,
            };
            tracked.LastRevision = number;
            tracked.UpdatedAt = row.CreatedAt;
            ApplySource(tracked, upload.Source);
            db.StackRevisions.Add(row);
            await db.SaveChangesAsync(cancellationToken);

            await AuditAsync(
                "stack.revision-upload",
                AuditResult.Success,
                caller,
                stack.Name,
                new()
                {
                    ["revision"] = number.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    ["sha256"] = row.ComposeSha256,
                    ["buildContext"] = upload.BuildContext ? "true" : "false",
                },
                cancellationToken);
            foreach (var id in acknowledged)
            {
                await AcknowledgmentAuditAsync(caller, stack.Name, number, id, cancellationToken);
            }
        }
        finally
        {
            _gate.Release();
        }

        return upload.BuildContext ? ToInfo(row) : await ValidateAsync(stack, row.Number, cancellationToken);
    }

    /// <summary>
    /// Unpacks the build context into the revision's files/ folder, straight from the request body,
    /// then validates the revision. A refused archive leaves nothing behind.
    /// </summary>
    public async Task<StackRevisionInfo> UploadContextAsync(
        Guid stackId,
        int number,
        Stream body,
        string? expectedSha256,
        StackCaller caller,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(body);
        var stack = await StackAsync(stackId, cancellationToken);
        var row = await RevisionAsync(stackId, number, cancellationToken);
        if (row.State != nameof(StackRevisionState.AwaitingContext))
        {
            throw new StackRefusedException("This revision is not waiting for a build context.", StatusCodes.Status409Conflict);
        }

        if (expectedSha256 is not null && (expectedSha256.Length != 64 || !expectedSha256.All(char.IsAsciiHexDigit)))
        {
            throw new StackRefusedException("X-Content-Sha256 is the archive's SHA-256 in hex.");
        }

        var files = Path.Combine(RevisionFolder(stackId, number), FilesFolder);
        using var hashing = new HashingStream(body);
        try
        {
            var result = await SafeTarExtractor.ExtractAsync(hashing, files, TarExtractionLimits.Default, cancellationToken);
            await hashing.DrainAsync(cancellationToken);
            if (expectedSha256 is not null && !string.Equals(hashing.Sha256(), expectedSha256, StringComparison.OrdinalIgnoreCase))
            {
                Directory.Delete(files, recursive: true);
                throw new ArchiveRejectedException("The build context did not arrive whole: its SHA-256 does not match.");
            }

            await AuditAsync(
                "stack.context-upload",
                AuditResult.Success,
                caller,
                stack.Name,
                new()
                {
                    ["revision"] = number.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    ["files"] = result.Files.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    ["bytes"] = result.Bytes.ToString(System.Globalization.CultureInfo.InvariantCulture),
                },
                cancellationToken);
        }
        catch (ArchiveRejectedException rejected)
        {
            await AuditAsync("stack.context-upload", AuditResult.Denied, caller, stack.Name, new() { ["reason"] = rejected.Message }, cancellationToken);
            throw new StackRefusedException(rejected.Message);
        }
        catch (IOException) when (Directory.Exists(files) && !cancellationToken.IsCancellationRequested)
        {
            throw new StackRefusedException("This revision already has its build context.", StatusCodes.Status409Conflict);
        }

        return await ValidateAsync(stack, number, cancellationToken);
    }

    /// <summary>
    /// Asks Compose to read the revision, then records its services, findings and bindings and
    /// writes the loopback override. Sets Ready or Invalid; nothing here refuses the request.
    /// </summary>
    private async Task<StackRevisionInfo> ValidateAsync(StackRecord stack, int number, CancellationToken cancellationToken)
    {
        var folder = RevisionFolder(stack.Id, number);
        var row = await RevisionAsync(stack.Id, number, cancellationToken);
        var proxied = Read<string[]>(row.ProxiedServices);
        var seeded = redactor.With(await EnvValuesAsync(folder, cancellationToken));
        string state;
        string? error = null;
        try
        {
            var checkedConfig = await CheckAsync(stack, folder, proxied, null, cancellationToken);
            row.Services = Write(checkedConfig.Services);
            row.Builds = checkedConfig.Builds;
            row.Findings = Write(checkedConfig.Findings);
            row.Bindings = Write(checkedConfig.Bindings);
            state = nameof(StackRevisionState.Ready);
        }
        catch (ComposeConfigException invalid)
        {
            state = nameof(StackRevisionState.Invalid);
            error = Clip(seeded.Redact(invalid.Message));
        }

        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        await db.StackRevisions
            .Where(r => r.StackId == stack.Id && r.Number == number)
            .ExecuteUpdateAsync(
                update => update
                    .SetProperty(r => r.State, state)
                    .SetProperty(r => r.Error, error)
                    .SetProperty(r => r.Services, row.Services)
                    .SetProperty(r => r.Builds, row.Builds)
                    .SetProperty(r => r.Findings, row.Findings)
                    .SetProperty(r => r.Bindings, row.Bindings),
                cancellationToken);
        row.State = state;
        row.Error = error;
        return ToInfo(row);
    }

    /// <param name="Registries">The registries of the images a pull fetches (E08), canonical hosts.</param>
    internal sealed record CheckedConfig(string[] Services, bool Builds, List<StackRisk> Findings, IReadOnlyList<StackPortBinding> Bindings, string[] Registries);

    /// <summary>
    /// docker compose config on the revision, the loopback override written from it, and Compose's
    /// reading again with the override, which must leave every proxied port on 127.0.0.1. Throws
    /// <see cref="ComposeConfigException"/> with Compose's own words when it refuses the files.
    /// </summary>
    internal async Task<CheckedConfig> CheckAsync(
        StackRecord stack,
        string folder,
        IReadOnlyCollection<string> proxied,
        Action<string>? note,
        CancellationToken cancellationToken)
    {
        var version = DockerRepository.ParseComposeVersion(await compose.VersionAsync(cancellationToken));
        if (version is null)
        {
            throw new ComposeConfigException("Docker Compose is not installed on this server. Install Docker from the Containers section first.");
        }

        if (version < DockerRepository.MinimumCompose)
        {
            throw new ComposeConfigException($"Docker Compose {version} is older than {DockerRepository.MinimumCompose}, which keeps proxied services on 127.0.0.1. Update Docker first.");
        }

        note?.Invoke($"Docker Compose {version}.");
        var overridePath = Path.Combine(folder, LoopbackOverride.FileName);
        foreach (var stale in new[] { overridePath, LoopbackOverride.PathIn(folder) })
        {
            if (File.Exists(stale))
            {
                File.Delete(stale);
            }
        }

        var plain = Project(stack.Name, folder, withOverride: false);
        using var config = await ConfigAsync(plain, cancellationToken);
        var rendered = LoopbackOverride.Render(config, proxied);
        if (rendered.Text is null)
        {
            var findings = ComposeConfigLint.Lint(config, proxied, plain.ProjectDirectory, directories.Data);
            return new CheckedConfig([.. config.Services.Select(s => s.Name)], config.Builds, findings, rendered.Bindings, RegistriesOf(config));
        }

        await WritePrivateAsync(overridePath, Encoding.UTF8.GetBytes(rendered.Text), cancellationToken);
        var withOverride = Project(stack.Name, folder, withOverride: true);
        using var final = await ConfigAsync(withOverride, cancellationToken);
        foreach (var service in final.Services.Where(s => proxied.Contains(s.Name)))
        {
            if (service.Ports.Any(port => !LoopbackOverride.IsLoopback(port.HostIp)))
            {
                throw new ComposeConfigException($"{service.Name} would still publish a port beyond 127.0.0.1 with the override. Check that Docker Compose is 2.24.4 or later.");
            }
        }

        var lint = ComposeConfigLint.Lint(final, proxied, withOverride.ProjectDirectory, directories.Data);
        return new CheckedConfig([.. final.Services.Select(s => s.Name)], final.Builds, lint, rendered.Bindings, RegistriesOf(final));
    }

    /// <summary>Where the images that docker compose pull fetches come from (built services are skipped, as pull skips them).</summary>
    private static string[] RegistriesOf(ComposeConfig config) =>
        [.. config.Services
            .Where(s => !s.Builds && s.Image is { Length: > 0 })
            .Select(s => DockerNames.TryParseReference(s.Image, out var image) ? RegistryNames.HostOfRepository(image.Repository) : null)
            .OfType<string>()
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)];

    internal static ComposeProject Project(string name, string folder, bool withOverride)
    {
        var overridePath = LoopbackOverride.PathIn(folder);
        List<string> files = [Path.Combine(folder, ComposeFileName)];
        if (withOverride && File.Exists(overridePath))
        {
            files.Add(overridePath);
        }

        return new ComposeProject(name, Path.Combine(folder, FilesFolder), files, Path.Combine(folder, EnvFileName));
    }

    /// <summary>The project as it runs: with the override when the revision has one.</summary>
    internal static ComposeProject Project(string name, string folder) => Project(name, folder, withOverride: true);

    private async Task<ComposeConfig> ConfigAsync(ComposeProject project, CancellationToken cancellationToken)
    {
        ProcessResult result;
        try
        {
            result = await compose.RunAsync(
                project,
                ["config", "--format", "json"],
                new ComposeRunOptions(ConfigTimeout, MaxOutputBytes: MaxConfigOutputBytes),
                onLine: null,
                cancellationToken);
        }
        catch (ProcessStartException)
        {
            throw new ComposeConfigException("Docker is not installed on this server.");
        }

        if (result.TimedOut)
        {
            throw new ComposeConfigException("docker compose config did not answer within a minute.");
        }

        if (!result.Succeeded)
        {
            var words = string.Join(' ', result.StandardError.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
            throw new ComposeConfigException(words.Length > 0 ? $"Docker Compose refused the files: {words}" : "Docker Compose refused the files.");
        }

        if (result.OutputTruncated)
        {
            throw new ComposeConfigException("The compose file comes out larger than the core reads.");
        }

        return ComposeConfig.Parse(result.StandardOutput);
    }

    /// <summary>The values of a revision's .env, for the redactor. Never logged, never returned.</summary>
    internal static async Task<IReadOnlyList<string>> EnvValuesAsync(string folder, CancellationToken cancellationToken)
    {
        var path = Path.Combine(folder, EnvFileName);
        if (!File.Exists(path))
        {
            return [];
        }

        var parsed = ComposeEnvFile.Parse(await File.ReadAllTextAsync(path, cancellationToken));
        return [.. parsed.Entries.Select(e => e.Value)];
    }

    private static string CheckUpload(StackRevisionUpload? upload)
    {
        if (upload is null || upload.Compose is null || upload.Env is null || upload.ProxiedServices is null || upload.AcknowledgedRisks is null)
        {
            return "Send the compose file, the .env, the proxied services and the acknowledged findings.";
        }

        if (string.IsNullOrWhiteSpace(upload.Compose))
        {
            return "The compose file is empty.";
        }

        if (Encoding.UTF8.GetByteCount(upload.Compose) > MaxComposeBytes || upload.Compose.Contains('\0', StringComparison.Ordinal))
        {
            return "The compose file is larger than 1 MB, or is not text.";
        }

        if (upload.ProxiedServices.Length > StackRules.MaxServices || !upload.ProxiedServices.All(StackRules.IsServiceName))
        {
            return "The proxied services are not service names.";
        }

        return upload.AcknowledgedRisks.Length > StackRules.MaxAcknowledgments || !upload.AcknowledgedRisks.All(StackRules.IsRiskId)
            ? $"Acknowledge at most {StackRules.MaxAcknowledgments} findings, by the ids the linter gave them."
            : string.Empty;
    }

    private static string Clip(string text) => text.Length <= MaxErrorLength ? text : text[..(MaxErrorLength - 3)] + "...";

    private static void CreatePrivateFolder(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            Directory.CreateDirectory(path);
            return;
        }

        Directory.CreateDirectory(path, PrivateFolder);
        if (File.GetUnixFileMode(path) != PrivateFolder)
        {
            File.SetUnixFileMode(path, PrivateFolder);
        }
    }

    /// <summary>Created 0600 from the start, so the content is never readable by anyone else even briefly.</summary>
    internal static async Task WritePrivateAsync(string path, byte[] content, CancellationToken cancellationToken)
    {
        var options = new FileStreamOptions { Mode = FileMode.Create, Access = FileAccess.Write, Share = FileShare.None };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = PrivateFile;
        }

        await using (var stream = new FileStream(path, options))
        {
            await stream.WriteAsync(content, cancellationToken);
        }

        if (!OperatingSystem.IsWindows() && File.GetUnixFileMode(path) != PrivateFile)
        {
            File.SetUnixFileMode(path, PrivateFile);
        }
    }

    /// <summary>Reads through, hashing every byte, so the archive is checked as it streams.</summary>
    private sealed class HashingStream(Stream inner) : Stream
    {
        private readonly IncrementalHash _hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public string Sha256() => Convert.ToHexStringLower(_hash.GetHashAndReset());

        public async Task DrainAsync(CancellationToken cancellationToken)
        {
            var buffer = new byte[81_920];
            while (await ReadAsync(buffer, cancellationToken) > 0)
            {
            }
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            var read = inner.Read(buffer, offset, count);
            _hash.AppendData(buffer, offset, read);
            return read;
        }

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            var read = await inner.ReadAsync(buffer, cancellationToken);
            _hash.AppendData(buffer.Span[..read]);
            return read;
        }

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _hash.Dispose();
            }

            base.Dispose(disposing);
        }
    }
}
