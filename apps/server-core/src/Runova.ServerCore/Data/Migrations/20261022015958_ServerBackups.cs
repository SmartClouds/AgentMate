using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Runova.ServerCore.Data.Migrations
{
    /// <inheritdoc />
    public partial class ServerBackups : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "BackupDestinations",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    Name = table.Column<string>(type: "TEXT", maxLength: 100, nullable: false),
                    Kind = table.Column<string>(type: "TEXT", maxLength: 20, nullable: false),
                    Settings = table.Column<string>(type: "TEXT", maxLength: 8192, nullable: false),
                    ProtectedSecret = table.Column<string>(type: "TEXT", nullable: true),
                    MaxPartBytes = table.Column<long>(type: "INTEGER", nullable: true),
                    CreatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    UpdatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    LastTestedAt = table.Column<long>(type: "INTEGER", nullable: true),
                    LastError = table.Column<string>(type: "TEXT", maxLength: 1000, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_BackupDestinations", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "BackupKeyRing",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false),
                    KeyId = table.Column<string>(type: "TEXT", maxLength: 32, nullable: false),
                    PublicKey = table.Column<string>(type: "TEXT", maxLength: 512, nullable: false),
                    Slot = table.Column<string>(type: "TEXT", maxLength: 2048, nullable: false),
                    CreatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    UpdatedAt = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_BackupKeyRing", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "BackupPlans",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    Name = table.Column<string>(type: "TEXT", maxLength: 100, nullable: false),
                    Enabled = table.Column<bool>(type: "INTEGER", nullable: false),
                    Cron = table.Column<string>(type: "TEXT", maxLength: 100, nullable: false),
                    TimeZone = table.Column<string>(type: "TEXT", maxLength: 100, nullable: false),
                    KeepLast = table.Column<int>(type: "INTEGER", nullable: false),
                    KeepDays = table.Column<int>(type: "INTEGER", nullable: true),
                    CreatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    UpdatedAt = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_BackupPlans", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "BackupRuns",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    PlanId = table.Column<Guid>(type: "TEXT", nullable: true),
                    PlanName = table.Column<string>(type: "TEXT", maxLength: 100, nullable: true),
                    Trigger = table.Column<string>(type: "TEXT", maxLength: 20, nullable: false),
                    State = table.Column<string>(type: "TEXT", maxLength: 20, nullable: false),
                    StartedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    FinishedAt = table.Column<long>(type: "INTEGER", nullable: true),
                    SizeBytes = table.Column<long>(type: "INTEGER", nullable: true),
                    Sha256 = table.Column<string>(type: "TEXT", maxLength: 64, nullable: true),
                    Error = table.Column<string>(type: "TEXT", maxLength: 1000, nullable: true),
                    RequestedByName = table.Column<string>(type: "TEXT", maxLength: 256, nullable: true),
                    KeepForDownload = table.Column<bool>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_BackupRuns", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "BackupPlanDestinations",
                columns: table => new
                {
                    PlanId = table.Column<Guid>(type: "TEXT", nullable: false),
                    DestinationId = table.Column<Guid>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_BackupPlanDestinations", x => new { x.PlanId, x.DestinationId });
                    table.ForeignKey(
                        name: "FK_BackupPlanDestinations_BackupDestinations_DestinationId",
                        column: x => x.DestinationId,
                        principalTable: "BackupDestinations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_BackupPlanDestinations_BackupPlans_PlanId",
                        column: x => x.PlanId,
                        principalTable: "BackupPlans",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "BackupRunTargets",
                columns: table => new
                {
                    RunId = table.Column<Guid>(type: "TEXT", nullable: false),
                    DestinationId = table.Column<Guid>(type: "TEXT", nullable: false),
                    DestinationName = table.Column<string>(type: "TEXT", maxLength: 100, nullable: false),
                    State = table.Column<string>(type: "TEXT", maxLength: 20, nullable: false),
                    Attempts = table.Column<int>(type: "INTEGER", nullable: false),
                    FinishedAt = table.Column<long>(type: "INTEGER", nullable: true),
                    Pruned = table.Column<int>(type: "INTEGER", nullable: false),
                    Error = table.Column<string>(type: "TEXT", maxLength: 1000, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_BackupRunTargets", x => new { x.RunId, x.DestinationId });
                    table.ForeignKey(
                        name: "FK_BackupRunTargets_BackupRuns_RunId",
                        column: x => x.RunId,
                        principalTable: "BackupRuns",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_BackupDestinations_Name",
                table: "BackupDestinations",
                column: "Name",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_BackupPlanDestinations_DestinationId",
                table: "BackupPlanDestinations",
                column: "DestinationId");

            migrationBuilder.CreateIndex(
                name: "IX_BackupPlans_Name",
                table: "BackupPlans",
                column: "Name",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_BackupRuns_PlanId",
                table: "BackupRuns",
                column: "PlanId");

            migrationBuilder.CreateIndex(
                name: "IX_BackupRuns_StartedAt",
                table: "BackupRuns",
                column: "StartedAt");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "BackupKeyRing");

            migrationBuilder.DropTable(
                name: "BackupPlanDestinations");

            migrationBuilder.DropTable(
                name: "BackupRunTargets");

            migrationBuilder.DropTable(
                name: "BackupDestinations");

            migrationBuilder.DropTable(
                name: "BackupPlans");

            migrationBuilder.DropTable(
                name: "BackupRuns");
        }
    }
}
