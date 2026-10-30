using Runova.Website.Core.ApiClients;

namespace Runova.Website.Tests.Mapping;

public class ApiClientMapperTests
{
    private static readonly DateTimeOffset _createdAt = new(2026, 10, 1, 8, 0, 0, TimeSpan.Zero);

    [Fact]
    public void A_client_maps_with_its_keys_and_version_and_no_sealed_key()
    {
        var client = new ApiClient
        {
            Id = 3,
            Name = "Advisory importer",
            Scopes = [ApiScopes.NewsWrite],
            IpAllowlist = ["203.0.113.0/24"],
            Keys = [new ApiClientKey { KeyId = "rk_5f2c9a1e7b3d4c60", SealedSigningKey = "sealed", CreatedAt = _createdAt }],
            LastUsedAt = _createdAt.AddDays(29),
            CreatedAt = _createdAt,
            Version = 887,
        };

        var dto = ApiClientMapper.ToDto(client);

        Assert.Equal(3, dto.Id);
        Assert.Equal("Advisory importer", dto.Name);
        Assert.Equal(["news:write"], dto.Scopes);
        Assert.Equal(["203.0.113.0/24"], dto.IpAllowlist);
        Assert.Equal(new ApiClientKeyDto("rk_5f2c9a1e7b3d4c60", _createdAt, null), Assert.Single(dto.Keys));
        Assert.Null(dto.ExpiresAt);
        Assert.Null(dto.RevokedAt);
        Assert.Equal(_createdAt.AddDays(29), dto.LastUsedAt);
        Assert.Equal("887", dto.Version);
        Assert.Empty(SecretProperties.In(typeof(ApiClientDto)));
    }

    [Fact]
    public void Only_the_created_and_rotated_answers_carry_a_secret()
    {
        Assert.Equal(["Secret"], SecretProperties.In(typeof(ApiClientCreatedDto)));
        Assert.Equal(["Secret"], SecretProperties.In(typeof(ApiClientSecretDto)));
    }
}
