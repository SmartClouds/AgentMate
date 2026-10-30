using Runova.Website.Core.Users;
using Runova.Website.Tests.Mapping;

namespace Runova.Website.Tests.Users;

public class UserMapperTests
{
    private sealed class StaffUser : IStaffUser
    {
        public long Id { get; init; } = 7;
        public string Email { get; init; } = "editor@runovahq.com";
        public string DisplayName { get; init; } = "Sam Editor";
        public DateTimeOffset? DisabledAt { get; init; }
        public bool EmailConfirmed { get; init; } = true;
        public bool TwoFactorEnabled { get; init; } = true;
        public DateTimeOffset? LastSignInAt { get; init; } = new DateTimeOffset(2026, 10, 30, 9, 12, 44, TimeSpan.Zero);
        public DateTimeOffset CreatedAt { get; init; } = new DateTimeOffset(2026, 10, 1, 8, 0, 0, TimeSpan.Zero);
        public uint Version { get; init; } = 1234;
    }

    [Fact]
    public void ToDto_copies_every_field_the_contract_shows()
    {
        var dto = UserMapper.ToDto(new StaffUser(), ["Editor"], lockedOutUntil: null);

        Assert.Equal(7, dto.Id);
        Assert.Equal("editor@runovahq.com", dto.Email);
        Assert.Equal("Sam Editor", dto.DisplayName);
        Assert.Equal(["Editor"], dto.Roles);
        Assert.False(dto.Disabled);
        Assert.True(dto.EmailConfirmed);
        Assert.True(dto.TwoFactorEnabled);
        Assert.Null(dto.LockedOutUntil);
        Assert.Equal(new DateTimeOffset(2026, 10, 30, 9, 12, 44, TimeSpan.Zero), dto.LastSignInAt);
        Assert.Equal(new DateTimeOffset(2026, 10, 1, 8, 0, 0, TimeSpan.Zero), dto.CreatedAt);
        Assert.Equal("1234", dto.Version);
    }

    [Fact]
    public void A_disabled_time_means_disabled()
    {
        var dto = UserMapper.ToDto(new StaffUser { DisabledAt = DateTimeOffset.UnixEpoch }, [], lockedOutUntil: null);

        Assert.True(dto.Disabled);
    }

    [Fact]
    public void The_dto_carries_no_secret()
    {
        Assert.Empty(SecretProperties.In(typeof(UserDto)));
    }
}
