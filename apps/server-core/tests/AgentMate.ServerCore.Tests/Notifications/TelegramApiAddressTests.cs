using AgentMate.ServerCore.Notifications;
using AgentMate.ServerCore.Tests.ErrorReporting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Time.Testing;

namespace AgentMate.ServerCore.Tests.Notifications;

/// <summary>
/// Where the bot's messages go: api.telegram.org, always, on a real server. Only a core started as
/// Development (the DevHost) may be pointed elsewhere, and only at this machine, so the app's e2e run
/// can stand in for Telegram. A token can never be sent anywhere else by a setting.
/// </summary>
public sealed class TelegramApiAddressTests
{
    private static IConfiguration Settings(string? apiBase) =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Core:Telegram:ApiBase"] = apiBase })
            .Build();

    [Fact]
    public void A_real_server_always_talks_to_api_telegram_org()
    {
        Assert.Equal(new Uri("https://api.telegram.org/"), TelegramBotClient.ApiAddress(Settings(null), development: false));
        Assert.Equal(new Uri("https://api.telegram.org/"), TelegramBotClient.ApiAddress(Settings("http://127.0.0.1:9/"), development: false));
    }

    [Theory]
    [InlineData("http://127.0.0.1:4567/", "http://127.0.0.1:4567/")]
    [InlineData("http://localhost:4567", "http://localhost:4567/")]
    [InlineData("http://[::1]:4567/", "http://[::1]:4567/")]
    public void The_dev_host_may_use_a_stand_in_on_this_machine(string setting, string expected)
    {
        Assert.Equal(new Uri(expected), TelegramBotClient.ApiAddress(Settings(setting), development: true));
    }

    [Theory]
    [InlineData("https://evil.example/")]
    [InlineData("http://10.0.0.5:4567/")]
    [InlineData("not a url")]
    [InlineData("")]
    public void Anywhere_else_is_ignored_even_on_the_dev_host(string setting)
    {
        Assert.Equal(new Uri("https://api.telegram.org/"), TelegramBotClient.ApiAddress(Settings(setting), development: true));
    }

    [Fact]
    public async Task Messages_go_to_the_address_it_was_given()
    {
        var telegram = new FakeIngest { Respond = _ => FakeTelegram.Ok() };
        using var client = new TelegramBotClient(new FakeTelegramTransport(telegram), new FakeTimeProvider(), new Uri("http://127.0.0.1:4567/"));

        await client.SendAsync(TelegramSettingsTests.Token, "123", "hi", TestContext.Current.CancellationToken);

        Assert.Equal($"http://127.0.0.1:4567/bot{TelegramSettingsTests.Token}/sendMessage", Assert.Single(telegram.Requests).Uri.ToString());
    }
}
