using Runova.Website.Core.Paging;
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
    public void A_lockout_end_passed_in_is_kept()
    {
        var until = new DateTimeOffset(2026, 10, 30, 12, 15, 0, TimeSpan.Zero);

        var dto = UserMapper.ToDto(new StaffUser(), ["Admin", "Editor"], until);

        Assert.Equal(until, dto.LockedOutUntil);
        Assert.Equal(["Admin", "Editor"], dto.Roles);
    }

    [Theory]
    [InlineData(typeof(UserDto))]
    [InlineData(typeof(UserInvitedDto))]
    [InlineData(typeof(SetupLinkDto))]
    [InlineData(typeof(Page<UserDto>))]
    public void No_user_dto_carries_a_secret(Type dto)
    {
        Assert.Empty(SecretProperties.In(dto));
    }
}
