namespace Runova.ServerCore.SystemTests;

/// <summary>
/// Keeps the system-test project honest until the first real system tests arrive with the test
/// servers (E03): on a qualifying host it proves the Docker daemon is reachable.
/// </summary>
public sealed class SystemTestEnvironmentTests
{
    [Fact]
    public void The_docker_daemon_socket_is_present()
    {
        SystemTestEnvironment.RequireAvailable();

        Assert.True(File.Exists("/var/run/docker.sock"));
    }
}
