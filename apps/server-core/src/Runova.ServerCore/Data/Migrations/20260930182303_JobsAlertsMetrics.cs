using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Runova.ServerCore.Data.Migrations
{
    /// <inheritdoc />
    public partial class JobsAlertsMetrics : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "Alerts",
                columns: table => new
                {
                    Id = table.Column<long>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    Revision = table.Column<long>(type: "INTEGER", nullable: false),
                    Kind = table.Column<string>(type: "TEXT", maxLength: 40, nullable: false),
                    Severity = table.Column<string>(type: "TEXT", maxLength: 20, nullable: false),
                    Resource = table.Column<string>(type: "TEXT", maxLength: 200, nullable: false),
                    Message = table.Column<string>(type: "TEXT", maxLength: 1000, nullable: false),
                    FirstSeenAt = table.Column<long>(type: "INTEGER", nullable: false),
                    LastSeenAt = table.Column<long>(type: "INTEGER", nullable: false),
                    Occurrences = table.Column<int>(type: "INTEGER", nullable: false),
                    AcknowledgedAt = table.Column<long>(type: "INTEGER", nullable: true),
                    AcknowledgedBy = table.Column<Guid>(type: "TEXT", nullable: true),
                    AcknowledgedByName = table.Column<string>(type: "TEXT", maxLength: 256, nullable: true),
                    ResolvedAt = table.Column<long>(type: "INTEGER", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Alerts", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Jobs",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    Kind = table.Column<string>(type: "TEXT", maxLength: 40, nullable: false),
                    Title = table.Column<string>(type: "TEXT", maxLength: 200, nullable: false),
                    State = table.Column<string>(type: "TEXT", maxLength: 20, nullable: false),
                    Resource = table.Column<string>(type: "TEXT", maxLength: 100, nullable: true),
                    RequestedBy = table.Column<Guid>(type: "TEXT", nullable: true),
                    RequestedByName = table.Column<string>(type: "TEXT", maxLength: 256, nullable: true),
                    CreatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    FinishedAt = table.Column<long>(type: "INTEGER", nullable: true),
                    ExitCode = table.Column<int>(type: "INTEGER", nullable: true),
                    Error = table.Column<string>(type: "TEXT", nullable: true),
                    LogLines = table.Column<long>(type: "INTEGER", nullable: false),
                    Cancellable = table.Column<bool>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Jobs", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "MetricSamples",
                columns: table => new
                {
                    Resolution = table.Column<int>(type: "INTEGER", nullable: false),
                    At = table.Column<long>(type: "INTEGER", nullable: false),
                    CpuPercent = table.Column<double>(type: "REAL", nullable: false),
                    CpuIowaitPercent = table.Column<double>(type: "REAL", nullable: false),
                    CpuStealPercent = table.Column<double>(type: "REAL", nullable: false),
                    Load1 = table.Column<double>(type: "REAL", nullable: false),
                    Load5 = table.Column<double>(type: "REAL", nullable: false),
                    Load15 = table.Column<double>(type: "REAL", nullable: false),
                    MemoryTotalBytes = table.Column<long>(type: "INTEGER", nullable: false),
                    MemoryUsedBytes = table.Column<long>(type: "INTEGER", nullable: false),
                    SwapTotalBytes = table.Column<long>(type: "INTEGER", nullable: false),
                    SwapUsedBytes = table.Column<long>(type: "INTEGER", nullable: false),
                    NetworkReceiveBytesPerSecond = table.Column<double>(type: "REAL", nullable: false),
                    NetworkTransmitBytesPerSecond = table.Column<double>(type: "REAL", nullable: false),
                    DiskReadBytesPerSecond = table.Column<double>(type: "REAL", nullable: false),
                    DiskWriteBytesPerSecond = table.Column<double>(type: "REAL", nullable: false),
                    DiskTotalBytes = table.Column<long>(type: "INTEGER", nullable: false),
                    DiskUsedBytes = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MetricSamples", x => new { x.Resolution, x.At });
                });

            migrationBuilder.CreateIndex(
                name: "IX_Alerts_Kind_Resource_ResolvedAt",
                table: "Alerts",
                columns: new[] { "Kind", "Resource", "ResolvedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Alerts_Revision",
                table: "Alerts",
                column: "Revision",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Jobs_CreatedAt",
                table: "Jobs",
                column: "CreatedAt");

            migrationBuilder.CreateIndex(
                name: "IX_Jobs_State",
                table: "Jobs",
                column: "State");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "Alerts");

            migrationBuilder.DropTable(
                name: "Jobs");

            migrationBuilder.DropTable(
                name: "MetricSamples");
        }
    }
}
