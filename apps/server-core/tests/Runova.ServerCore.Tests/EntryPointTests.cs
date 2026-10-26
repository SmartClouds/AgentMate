using System.Text.Json;
using Runova.ServerCore.Cli;

namespace Runova.ServerCore.Tests;

/// <summary>
/// One binary serves the API and answers the installer's admin commands. Only an exact "admin"
/// first argument leaves the web host path, because the test factory and other tooling call the
/// entry point with arguments of their own and must always reach the host.
/// </summary>
public sealed class EntryPointTests
{
    [Fact]
    public async Task Admin_version_prints_json_without_starting_the_web_host()
    {
        using var output = new StringWriter();
        using var error = new StringWriter();

        var exitCode = await CoreEntryPoint.RunAsync(
            ["admin", "version"],
            output,
            error,
            _ => throw new InvalidOperationException("The web host must not start for admin commands."));

        Assert.Equal(0, exitCode);
        Assert.Equal(string.Empty, error.ToString());
        using var json = JsonDocument.Parse(output.ToString());
        Assert.Equal(CoreVersion.Current, json.RootElement.GetProperty("version").GetString());
        Assert.Equal(CoreVersion.ApiVersion, json.RootElement.GetProperty("apiVersion").GetInt32());
        Assert.False(string.IsNullOrEmpty(json.RootElement.GetProperty("architecture").GetString()));
    }

    [Fact]
    public async Task An_unknown_admin_command_fails_with_usage()
    {
        using var output = new StringWriter();
        using var error = new StringWriter();

        var exitCode = await CoreEntryPoint.RunAsync(
            ["admin", "launch-rockets"],
            output,
            error,
            _ => throw new InvalidOperationException("The web host must not start for admin commands."));

        Assert.Equal(2, exitCode);
        Assert.Contains("Usage", error.ToString(), StringComparison.Ordinal);
        Assert.Equal(string.Empty, output.ToString());
    }

    [Fact]
    public async Task The_firewall_rollback_runs_without_starting_the_web_host()
    {
        using var output = new StringWriter();
        using var error = new StringWriter();

        var exitCode = await CoreEntryPoint.RunAsync(
            ["firewall-revert", "--help"],
            output,
            error,
            _ => throw new InvalidOperationException("The web host must not start for the firewall rollback."));

        Assert.Equal(2, exitCode);
        Assert.Contains("Usage: runova-core firewall-revert", error.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Serve_strips_its_verb_and_starts_the_web_host()
    {
        string[]? served = null;

        var exitCode = await CoreEntryPoint.RunAsync(
            ["serve", "--urls", "x"],
            TextWriter.Null,
            TextWriter.Null,
            args =>
            {
                served = args;
                return Task.FromResult(0);
            });

        Assert.Equal(0, exitCode);
        Assert.NotNull(served);
        Assert.Equal(["--urls", "x"], served);
    }

    public static TheoryData<string[]> HostArguments => new()
    {
        Array.Empty<string>(),
        new[] { "--environment", "Testing" },
        new[] { "--applicationName", "runova-core" },
        new[] { "Admin", "version" },
    };

    [Theory]
    [MemberData(nameof(HostArguments))]
    public async Task Anything_else_reaches_the_web_host_unchanged(string[] args)
    {
        string[]? served = null;

        await CoreEntryPoint.RunAsync(
            args,
            TextWriter.Null,
            TextWriter.Null,
            received =>
            {
                served = received;
                return Task.FromResult(0);
            });

        Assert.NotNull(served);
        Assert.Equal(args, served);
    }

    [Fact]
    public void The_test_factory_boots_the_real_host()
    {
        using var factory = new CoreFactory();

        Assert.NotNull(factory.Services);
    }
}
