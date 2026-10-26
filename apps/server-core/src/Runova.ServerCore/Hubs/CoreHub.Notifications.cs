using Microsoft.AspNetCore.Authorization;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Hubs;

/// <summary>
/// Telegram notifications (E30). Admins read how it stands and send a test message. Changing it sends
/// what happens on the server to a third party, so it is an Owner's call and needs a step-up. Every
/// change lands in the audit trail with the chat and the kinds, never the token.
/// </summary>
internal sealed partial class CoreHub
{
    [Authorize(Policy = CorePolicies.Admin)]
    public Task<TelegramNotificationsStatus> GetTelegramNotifications() => telegram.StatusAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<TelegramNotificationsSaveResult> SaveTelegramNotifications(TelegramNotificationsRequest request)
    {
        var result = await telegram.SaveAsync(request, Caller.UserName, Context.ConnectionAborted);
        var parameters = new Dictionary<string, string?>
        {
            ["enabled"] = request?.Enabled.ToString(),
            ["chat"] = request?.ChatId,
            ["serverName"] = request?.ServerName,
            ["sendResolved"] = request?.SendResolved.ToString(),
            ["newToken"] = (!string.IsNullOrWhiteSpace(request?.BotToken)).ToString(),
        };
        if (result.Status is { } status)
        {
            parameters["kinds"] = string.Join(',', status.Kinds);
        }
        else
        {
            parameters["reason"] = string.Join(' ', result.Problems);
        }

        await AuditAsync("telegram.save", result.Problems.Length == 0 ? AuditResult.Success : AuditResult.Denied, null, parameters);
        return result;
    }

    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<TelegramNotificationsStatus> RemoveTelegramNotifications()
    {
        var status = await telegram.RemoveAsync(Caller.UserName, Context.ConnectionAborted);
        await AuditAsync("telegram.remove", AuditResult.Success);
        return status;
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<TelegramNotificationsTestResult> SendTelegramNotificationTest()
    {
        var result = await telegram.SendTestAsync(Caller.UserName, Context.ConnectionAborted);
        var status = await telegram.StatusAsync(Context.ConnectionAborted);
        await AuditAsync(
            "telegram.test",
            result.Delivered ? AuditResult.Success : AuditResult.Failed,
            null,
            new() { ["chat"] = status.ChatId });
        return result;
    }
}
