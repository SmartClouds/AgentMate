namespace Runova.Website.Tests.Mapping;

public class SecretPropertiesTests
{
    private sealed record Leaky(string PasswordHash, string SecurityStamp, string Name);

    private sealed record Outer(Leaky Inner, IReadOnlyList<Leaky> Many);

    [Fact]
    public void Finds_a_secret_property()
    {
        Assert.Equal(["PasswordHash", "SecurityStamp"], SecretProperties.In(typeof(Leaky)));
    }

    [Fact]
    public void Finds_a_secret_inside_a_nested_dto_or_a_list_of_them()
    {
        Assert.Equal(
            ["Inner.PasswordHash", "Inner.SecurityStamp", "Many.PasswordHash", "Many.SecurityStamp"],
            SecretProperties.In(typeof(Outer)));
    }
}
