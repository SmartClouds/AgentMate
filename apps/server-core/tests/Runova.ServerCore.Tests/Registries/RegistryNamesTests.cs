using Runova.ServerCore.Registries;

namespace Runova.ServerCore.Tests.Registries;

public sealed class RegistryNamesTests
{
    [Theory]
    [InlineData("ghcr.io", "ghcr.io")]
    [InlineData("GHCR.io", "ghcr.io")]
    [InlineData("docker.io", "docker.io")]
    [InlineData("index.docker.io", "docker.io")]
    [InlineData("registry-1.docker.io", "docker.io")]
    [InlineData("https://index.docker.io/v1/", "docker.io")]
    [InlineData("registry.example.com:5000", "registry.example.com:5000")]
    [InlineData("localhost:5000", "localhost:5000")]
    [InlineData("127.0.0.1:5000", "127.0.0.1:5000")]
    [InlineData("https://ghcr.io/", "ghcr.io")]
    public void Registries_are_named_by_their_host(string value, string expected)
    {
        Assert.True(RegistryNames.TryNormalizeRegistry(value, out var host));
        Assert.Equal(expected, host);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("ghcr.io/org")]
    [InlineData("ghcr.io:0")]
    [InlineData("ghcr.io:70000")]
    [InlineData("-bad.example")]
    [InlineData("bad..example")]
    [InlineData("http://ghcr.io")]
    [InlineData("ghcr.io\n")]
    [InlineData("ghcr io")]
    [InlineData("user@ghcr.io")]
    public void Anything_else_is_not_a_registry(string? value)
    {
        Assert.False(RegistryNames.TryNormalizeRegistry(value, out _));
    }

    [Theory]
    [InlineData("nginx", "docker.io")]
    [InlineData("library/nginx", "docker.io")]
    [InlineData("someone/app", "docker.io")]
    [InlineData("ghcr.io/org/app", "ghcr.io")]
    [InlineData("localhost/app", "localhost")]
    [InlineData("localhost:5000/team/app", "localhost:5000")]
    [InlineData("Registry.Example.com:5000/app", "registry.example.com:5000")]
    [InlineData("docker.io/library/nginx", "docker.io")]
    public void An_image_belongs_to_the_registry_its_first_part_names(string repository, string expected)
    {
        Assert.Equal(expected, RegistryNames.HostOfRepository(repository));
    }

    [Fact]
    public void Docker_Hub_is_keyed_the_way_the_docker_cli_keys_it()
    {
        Assert.Equal("https://index.docker.io/v1/", RegistryNames.ConfigKey("docker.io"));
        Assert.Equal("ghcr.io", RegistryNames.ConfigKey("ghcr.io"));
    }

    [Theory]
    [InlineData("octocat", true)]
    [InlineData("robot$team+ci", true)]
    [InlineData("", false)]
    [InlineData("has:colon", false)]
    [InlineData("new\nline", false)]
    public void User_names_cannot_break_basic_auth(string value, bool valid)
    {
        Assert.Equal(valid, RegistryNames.IsUsername(value));
    }

    [Theory]
    [InlineData("ghp_abcdefghijklmnopqrstuvwxyz0123456789", true)]
    [InlineData("pass word with spaces", true)]
    [InlineData("", false)]
    [InlineData("   ", false)]
    [InlineData("abc", false)]
    [InlineData("tab\there", false)]
    [InlineData("line\nbreak", false)]
    public void Secrets_are_one_line_of_text(string value, bool valid)
    {
        Assert.Equal(valid, RegistryNames.IsSecret(value));
    }

    [Fact]
    public void A_secret_has_a_length_limit()
    {
        Assert.True(RegistryNames.IsSecret(new string('a', RegistryNames.MaxSecretLength)));
        Assert.False(RegistryNames.IsSecret(new string('a', RegistryNames.MaxSecretLength + 1)));
    }
}
