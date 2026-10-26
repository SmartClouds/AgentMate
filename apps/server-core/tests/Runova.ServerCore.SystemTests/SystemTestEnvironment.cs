namespace Runova.ServerCore.SystemTests;

/// <summary>
/// System tests drive real Linux machinery (Docker, the test-server containers, nginx, Pebble).
/// They only run on a Linux host with a Docker daemon, which the nightly workflow provides.
/// </summary>
internal static class SystemTestEnvironment
{
    private const string DockerSocket = "/var/run/docker.sock";

    public static bool IsAvailable => OperatingSystem.IsLinux() && File.Exists(DockerSocket);

    public static void RequireAvailable() =>
        Assert.SkipUnless(IsAvailable, "System tests need Linux with a Docker daemon.");
}
