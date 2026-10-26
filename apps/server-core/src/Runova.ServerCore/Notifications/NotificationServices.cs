using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Runova.ServerCore.Notifications;

internal static class NotificationServices
{
    /// <summary>
    /// Adds Telegram notifications: a notifier that listens to the alert center and sends to a chat once
    /// a person sets it up. Nothing is sent, and nothing leaves the machine, until then.
    /// </summary>
    public static IServiceCollection AddTelegramNotifications(this IServiceCollection services)
    {
        services.TryAddSingleton<ITelegramTransport, SocketsTelegramTransport>();
        services.AddSingleton(provider => new TelegramBotClient(
            provider.GetRequiredService<ITelegramTransport>(),
            provider.GetRequiredService<TimeProvider>(),
            TelegramBotClient.ApiAddress(
                provider.GetRequiredService<IConfiguration>(),
                provider.GetRequiredService<IHostEnvironment>().IsDevelopment())));
        services.AddSingleton(provider => new TelegramManager(
            provider.GetRequiredService<IConfiguration>(),
            provider.GetRequiredService<TelegramBotClient>(),
            provider.GetRequiredService<Microsoft.AspNetCore.DataProtection.IDataProtectionProvider>(),
            provider.GetRequiredService<TimeProvider>(),
            provider.GetRequiredService<ILogger<TelegramManager>>()));
        services.AddHostedService<TelegramNotifier>();
        return services;
    }
}
