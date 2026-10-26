using System.Text.Json;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Stacks;

namespace Runova.ServerCore.Tests.Stacks;

/// <summary>
/// The pieces a deploy is checked with: the linter that must agree with the app's (same ids for
/// every finding that needs an acknowledgment), the loopback override, the .env reader that seeds
/// the redactor, and the name rules.
/// </summary>
public sealed class StackLibraryTests
{
    private const string ProjectDirectory = "/srv/app/files";
    private const string CoreData = "/var/lib/runova-core";

    private static ComposeConfig Parity() => ComposeConfig.Parse(Fixtures.Read("stacks/lint-parity.config.json"));

    [Fact]
    public void The_core_finds_the_same_ids_as_the_app_for_everything_that_needs_an_acknowledgment()
    {
        using var config = Parity();
        var expected = JsonSerializer.Deserialize<string[]>(Fixtures.Read("stacks/lint-parity.expected.json"))!;

        var found = ComposeConfigLint.Lint(config, ["proxied"], ProjectDirectory, CoreData)
            .Where(risk => ComposeConfigLint.NeedsAcknowledgment(risk.Severity))
            .Select(risk => risk.Id);

        Assert.Equal(expected.Order(StringComparer.Ordinal), found.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void A_bind_mount_inside_the_revision_is_the_apps_own_and_a_proxied_port_is_not_public()
    {
        using var config = Parity();

        var risks = ComposeConfigLint.Lint(config, ["proxied"], ProjectDirectory, CoreData);

        Assert.DoesNotContain(risks, risk => risk.Id.Contains("/srv/app/files", StringComparison.Ordinal));
        Assert.DoesNotContain(risks, risk => risk.Service == "proxied" && risk.Rule == "public-port");
        Assert.Contains(risks, risk => risk.Id == "privileged:web" && risk.Severity == StackRiskSeverity.Critical);
        Assert.Contains(risks, risk => risk.Id == "public-port:web:*:8080:80/tcp" && risk.Severity == StackRiskSeverity.Medium);
    }

    [Fact]
    public void A_service_left_public_reports_its_ports()
    {
        using var config = Parity();

        var risks = ComposeConfigLint.Lint(config, [], ProjectDirectory, CoreData);

        Assert.Contains(risks, risk => risk.Id == "public-port:proxied:*:3000:3000/tcp");
    }

    [Fact]
    public void The_override_binds_every_port_of_a_proxied_service_to_loopback_and_replaces_the_list()
    {
        using var config = ComposeConfig.Parse("""
            {"name":"site","services":{
              "web":{"image":"nginx","ports":[
                {"mode":"ingress","target":80,"published":"8080","protocol":"tcp"},
                {"mode":"ingress","host_ip":"::","target":443,"published":"8443","protocol":"tcp"}]},
              "db":{"image":"postgres","ports":[{"mode":"ingress","target":5432,"published":"5432","protocol":"tcp"}]}}}
            """);

        var result = LoopbackOverride.Render(config, ["web"]);

        Assert.NotNull(result.Text);
        Assert.Contains("\"web\":\n    ports: !override\n", result.Text, StringComparison.Ordinal);
        Assert.Contains("        published: \"8443\"\n        host_ip: 127.0.0.1\n", result.Text, StringComparison.Ordinal);
        Assert.DoesNotContain("db", result.Text, StringComparison.Ordinal);
        Assert.Equal(
            [("web", 80, "127.0.0.1"), ("web", 443, "127.0.0.1"), ("db", 5432, (string?)null)],
            result.Bindings.Select(binding => (binding.Service, binding.Target, binding.HostIp)));
    }

    [Fact]
    public void No_override_is_written_when_no_proxied_service_publishes_anything()
    {
        using var config = ComposeConfig.Parse("""{"services":{"worker":{"image":"busybox"}}}""");

        var result = LoopbackOverride.Render(config, ["worker"]);

        Assert.Null(result.Text);
        Assert.Empty(result.Bindings);
    }

    [Fact]
    public void A_proxied_service_on_the_host_network_or_one_that_does_not_exist_is_refused()
    {
        using var config = ComposeConfig.Parse("""{"services":{"agent":{"image":"x","network_mode":"host"}}}""");

        Assert.Contains("network_mode: host", Assert.Throws<ComposeConfigException>(() => LoopbackOverride.Render(config, ["agent"])).Message, StringComparison.Ordinal);
        Assert.Contains("no service called ghost", Assert.Throws<ComposeConfigException>(() => LoopbackOverride.Render(config, ["ghost"])).Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Config_output_the_core_cannot_trust_is_refused()
    {
        Assert.Throws<ComposeConfigException>(() => ComposeConfig.Parse("""{"services":{"web":{"ports":[{"target":80,"published":"80\"\n","protocol":"tcp"}]}}}"""));
        Assert.Throws<ComposeConfigException>(() => ComposeConfig.Parse("""{"services":{"web":{"ports":[{"target":80,"protocol":"quic"}]}}}"""));
        Assert.Throws<ComposeConfigException>(() => ComposeConfig.Parse("""{"services":{"web":{"ports":[{"target":80,"host_ip":"evil host","protocol":"tcp"}]}}}"""));
    }

    [Fact]
    public void The_env_file_reads_back_what_the_app_rendered_escapes_included()
    {
        // As composeEnv.ts writes it: double quotes, backslash escapes, $ doubled, octal controls.
        var text = "# Written by Runova\nGREETING=\" it's \\\"quoted\\\" $$HOME \\\\ #x\\nsecond \"\nBELL=\"a\\0007b\"\nEMPTY=\"\"\n";

        var result = ComposeEnvFile.Parse(text);

        Assert.True(result.Ok, result.Problem);
        Assert.Equal(
            [
                new KeyValuePair<string, string>("GREETING", " it's \"quoted\" $HOME \\ #x\nsecond "),
                new KeyValuePair<string, string>("BELL", "a\ab"),
                new KeyValuePair<string, string>("EMPTY", string.Empty),
            ],
            result.Entries);
    }

    [Theory]
    [InlineData("KEY=unquoted\n")]
    [InlineData("KEY=\"no end\n")]
    [InlineData("1KEY=\"x\"\n")]
    [InlineData("KEY\n")]
    public void An_env_file_the_app_could_not_have_written_is_refused(string text)
    {
        Assert.False(ComposeEnvFile.Parse(text).Ok);
    }

    [Theory]
    [InlineData("shop", true)]
    [InlineData("shop-api_2", true)]
    [InlineData("Shop", false)]
    [InlineData("-shop", false)]
    [InlineData("shop app", false)]
    [InlineData("", false)]
    public void Stack_names_follow_compose_project_names(string name, bool valid)
    {
        Assert.Equal(valid, StackRules.IsStackName(name));
        Assert.Equal(valid, StackRules.StackNameProblem(name) is null);
    }
}
