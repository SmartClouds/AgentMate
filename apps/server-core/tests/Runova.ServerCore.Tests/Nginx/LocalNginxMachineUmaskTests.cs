using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Tests.Nginx;

/// <summary>The process umask is shared by every test, so the tests that change it run alone.</summary>
[CollectionDefinition(nameof(ProcessUmask), DisableParallelization = true)]
public sealed class ProcessUmask;

/// <summary>
/// The core runs with UMask=0077. Folders it makes for nginx (the ACME webroot, site roots) must
/// still be 0755 all the way down, or nginx's workers cannot reach what is inside. Found by the
/// full-stack run: HTTP-01 answered 404 because /var/www and /var/www/runova came out 0700.
/// </summary>
[Collection(nameof(ProcessUmask))]
[SupportedOSPlatform("linux")]
public sealed partial class LocalNginxMachineUmaskTests : IDisposable
{
    private const UnixFileMode Open =
        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
        | UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute;

    private const UnixFileMode Private = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;

    private readonly TestRoot _root = new();

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    [Fact]
    public async Task New_parent_folders_are_0755_under_the_services_umask()
    {
        Assert.SkipUnless(OperatingSystem.IsLinux(), "Modes and umask need Linux here.");
        var machine = new LocalNginxMachine(new FakeProcessRunner(), Units.Runner(new FakeProcessRunner()), _root.Path);

        var previous = Umask(0b000_111_111);
        try
        {
            await machine.CreateDirectoryAsync("/var/www/runova/acme/.well-known/acme-challenge", Open, Cancel);
            await machine.WriteAsync("/srv/runova/sites/blog/index.html", "hi"u8.ToArray(), UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead, Cancel);
            await machine.CreateDirectoryAsync("/etc/nginx/runova/certs/blog", Private, Cancel);
        }
        finally
        {
            _ = Umask(previous);
        }

        string[] open =
        [
            "/var", "/var/www", "/var/www/runova", "/var/www/runova/acme", "/var/www/runova/acme/.well-known",
            "/var/www/runova/acme/.well-known/acme-challenge", "/srv", "/srv/runova", "/srv/runova/sites",
            "/srv/runova/sites/blog", "/etc", "/etc/nginx", "/etc/nginx/runova", "/etc/nginx/runova/certs",
        ];
        Assert.All(open, folder => Assert.Equal((folder, Open), (folder, File.GetUnixFileMode(_root.Resolve(folder)))));
        Assert.Equal(Private, File.GetUnixFileMode(_root.Resolve("/etc/nginx/runova/certs/blog")));
    }

    public void Dispose() => _root.Dispose();

    [LibraryImport("libc", EntryPoint = "umask")]
    private static partial uint Umask(uint mask);
}
