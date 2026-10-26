using System.Formats.Tar;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using Microsoft.AspNetCore.SignalR;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests.Stacks;

/// <summary>
/// The REST uploads end to end (AC1): a revision's files as JSON, then its build context streamed
/// into the safe extractor. Archives that reach outside the stack's folder (absolute paths, "..",
/// links that lead out, devices) or would blow up (a size past the cap) are refused before
/// anything is written outside it, and a refused one leaves the revision waiting for a good one.
/// </summary>
public sealed class StackUploadTests
{
    private const string Builds = """
        services:
          api:
            build: ./api
            restart: unless-stopped
            ports:
              - "3000:3000"
        """;

    private static CancellationToken Cancel => StackKit.Cancel;

    private static async Task<(StackKit Kit, StackInfo Stack, StackRevisionInfo Revision)> AwaitingAsync()
    {
        var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();
        var revision = await kit.UploadAsync(stack.Id, StackKit.Upload(Builds, proxied: ["api"], context: true));
        return (kit, stack, revision);
    }

    private static async Task<string> RefusalOf(HttpResponseMessage response) =>
        (await response.Content.ReadFromJsonAsync<StackUploadError>(CoreJson.Options, Cancel))!.Message;

    public static TheoryData<string, string> Escapes() => new()
    {
        { "absolute", "/etc/cron.d/planted" },
        { "dot-dot", "../../../planted.txt" },
        { "nested-dot-dot", "api/../../planted.txt" },
    };

    [Fact]
    public async Task A_build_context_arrives_whole_lands_in_the_revision_and_the_deploy_builds_from_it()
    {
        var (kit, stack, revision) = await AwaitingAsync();
        await using var _ = kit;
        using var archive = StackKit.Archive(StackKit.File("api/Dockerfile", "FROM scratch\n"), StackKit.File("api/server.js", "// app\n"));
        var sha = StackKit.Sha(archive);

        using var response = await kit.PutContextAsync(stack.Id, revision.Number, archive, sha);
        var ready = (await response.Content.ReadFromJsonAsync<StackRevisionInfo>(CoreJson.Options, Cancel))!;
        var (job, _) = await kit.RunAsync(await kit.DeployAsync(stack.Id, revision.Number));
        var steps = (await kit.GetAsync(stack.Id)).Revisions[0].Steps;

        Assert.Equal(StackRevisionState.AwaitingContext, revision.State);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(StackRevisionState.Ready, ready.State);
        Assert.True(ready.HasBuildContext);
        var files = Path.Combine(kit.DataDirectory, "stacks", stack.Id.ToString("N"), "revisions", "1", "files");
        Assert.Equal("FROM scratch\n", await File.ReadAllTextAsync(Path.Combine(files, "api", "Dockerfile"), Cancel));
        Assert.Equal(JobState.Succeeded, job.State);
        Assert.Equal(StackStepState.Succeeded, steps.Single(step => step.Kind == StackStepKind.Build).State);
        Assert.Contains(await kit.AuditAsync(), e => e.Action == "stack.context-upload" && e.Result == "success");
    }

    [Theory]
    [MemberData(nameof(Escapes))]
    public async Task An_archive_entry_that_leaves_the_folder_is_refused_and_nothing_is_written_outside(string why, string name)
    {
        var (kit, stack, revision) = await AwaitingAsync();
        await using var _ = kit;
        using var archive = StackKit.Archive(StackKit.File("api/Dockerfile", "FROM scratch\n"), StackKit.File(name, "pwned"));

        using var response = await kit.PutContextAsync(stack.Id, revision.Number, archive);

        Assert.True(response.StatusCode == HttpStatusCode.BadRequest, why);
        Assert.NotEmpty(await RefusalOf(response));
        await AssertNothingLandedAsync(kit, stack, revision);
    }

    [Fact]
    public async Task A_link_out_of_the_folder_and_a_device_are_refused()
    {
        var (kit, stack, revision) = await AwaitingAsync();
        await using var _ = kit;

        using var link = StackKit.Archive(new PaxTarEntry(TarEntryType.SymbolicLink, "api/escape") { LinkName = "../../../../.." }, StackKit.File("api/escape/planted.txt", "pwned"));
        using var linkResponse = await kit.PutContextAsync(stack.Id, revision.Number, link);
        using var hard = StackKit.Archive(new PaxTarEntry(TarEntryType.HardLink, "api/passwd") { LinkName = "/etc/passwd" });
        using var hardResponse = await kit.PutContextAsync(stack.Id, revision.Number, hard);
        using var device = StackKit.Archive(new PaxTarEntry(TarEntryType.CharacterDevice, "api/null") { DeviceMajor = 1, DeviceMinor = 3 });
        using var deviceResponse = await kit.PutContextAsync(stack.Id, revision.Number, device);

        Assert.Equal(HttpStatusCode.BadRequest, linkResponse.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, hardResponse.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, deviceResponse.StatusCode);
        await AssertNothingLandedAsync(kit, stack, revision);
        Assert.Equal(3, (await kit.AuditAsync()).Count(e => e.Action == "stack.context-upload" && e.Result == "denied"));
    }

    [Fact]
    public async Task A_bomb_is_refused_at_the_header_that_passes_the_cap()
    {
        var (kit, stack, revision) = await AwaitingAsync();
        await using var _ = kit;
        // 257 MB of zeros compresses to a few hundred KB; the cap is 256 MB unpacked.
        var bomb = new PaxTarEntry(TarEntryType.RegularFile, "api/zeros") { DataStream = new ZeroStream(257L * 1024 * 1024) };
        using var archive = StackKit.Archive(bomb);

        using var response = await kit.PutContextAsync(stack.Id, revision.Number, archive);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("MB", await RefusalOf(response), StringComparison.Ordinal);
        await AssertNothingLandedAsync(kit, stack, revision);
    }

    [Fact]
    public async Task A_context_that_does_not_match_its_hash_or_is_not_gzip_is_refused()
    {
        var (kit, stack, revision) = await AwaitingAsync();
        await using var _ = kit;
        using var archive = StackKit.Archive(StackKit.File("api/Dockerfile", "FROM scratch\n"));

        using var wrongHash = await kit.PutContextAsync(stack.Id, revision.Number, archive, new string('a', 64));
        using var notGzip = await kit.PutContextAsync(stack.Id, revision.Number, new MemoryStream(Encoding.UTF8.GetBytes("plain text")));

        Assert.Equal(HttpStatusCode.BadRequest, wrongHash.StatusCode);
        Assert.Contains("SHA-256", await RefusalOf(wrongHash), StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.BadRequest, notGzip.StatusCode);
        await AssertNothingLandedAsync(kit, stack, revision);
    }

    [Fact]
    public async Task A_revision_waiting_for_its_context_cannot_be_deployed_and_takes_one_context_only()
    {
        var (kit, stack, revision) = await AwaitingAsync();
        await using var _ = kit;

        var early = await Assert.ThrowsAsync<HubException>(() => kit.DeployAsync(stack.Id, revision.Number));
        using var first = await kit.PutContextAsync(stack.Id, revision.Number, StackKit.Archive(StackKit.File("api/Dockerfile", "FROM scratch\n")));
        using var second = await kit.PutContextAsync(stack.Id, revision.Number, StackKit.Archive(StackKit.File("api/Dockerfile", "FROM scratch\n")));

        Assert.NotEmpty(early.Message);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, second.StatusCode);
    }

    [Fact]
    public async Task Revisions_over_the_caps_or_with_an_env_the_app_could_not_have_written_are_refused()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();

        using var huge = await kit.PostRevisionAsync(stack.Id, StackKit.Upload(compose: "# " + new string('x', 5 * 1024 * 1024)));
        using var badEnv = await kit.PostRevisionAsync(stack.Id, StackKit.Upload(env: "DB_PASSWORD=unquoted\n"));
        using var badService = await kit.PostRevisionAsync(stack.Id, StackKit.Upload(proxied: ["web; rm -rf /"]));
        using var unknown = await kit.PostRevisionAsync(Guid.NewGuid(), StackKit.Upload());

        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, huge.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, badEnv.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, badService.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
        Assert.Empty((await kit.GetAsync(stack.Id)).Revisions);
    }

    [Fact]
    public async Task A_compose_file_that_compose_refuses_makes_an_invalid_revision_with_the_reason()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();

        var revision = await kit.UploadAsync(stack.Id, StackKit.Upload(compose: "services:\n  web:\n    image: [\n", proxied: []));

        Assert.Equal(StackRevisionState.Invalid, revision.State);
        Assert.False(string.IsNullOrEmpty(revision.Error));
        await Assert.ThrowsAsync<HubException>(() => kit.DeployAsync(stack.Id, revision.Number));
    }

    private static async Task AssertNothingLandedAsync(StackKit kit, StackInfo stack, StackRevisionInfo revision)
    {
        var files = Path.Combine(kit.DataDirectory, "stacks", stack.Id.ToString("N"), "revisions", revision.Number.ToString(System.Globalization.CultureInfo.InvariantCulture), "files");
        Assert.False(Directory.Exists(files) && Directory.EnumerateFileSystemEntries(files).Any(), "the refused archive left files behind");
        Assert.DoesNotContain(kit.FilesOutsideStacks(), path => path.Contains("planted", StringComparison.Ordinal) || path.Contains("passwd", StringComparison.Ordinal));
        Assert.False(File.Exists(Path.Combine(Path.GetTempPath(), "planted.txt")));
        var details = await kit.GetAsync(stack.Id);
        Assert.Equal(StackRevisionState.AwaitingContext, details.Revisions[0].State);
    }

    /// <summary>Reads as zeros up to a length, without holding them.</summary>
    private sealed class ZeroStream(long length) : Stream
    {
        private long _position;

        public override bool CanRead => true;

        public override bool CanSeek => true;

        public override bool CanWrite => false;

        public override long Length => length;

        public override long Position
        {
            get => _position;
            set => _position = value;
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            var read = (int)Math.Min(count, length - _position);
            Array.Clear(buffer, offset, read);
            _position += read;
            return read;
        }

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => _position = origin switch
        {
            SeekOrigin.Begin => offset,
            SeekOrigin.Current => _position + offset,
            _ => length + offset,
        };

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
