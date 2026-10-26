using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Runova.ServerCore.Data.Migrations
{
    /// <inheritdoc />
    public partial class Stacks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "Stacks",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    Name = table.Column<string>(type: "TEXT", maxLength: 63, nullable: false),
                    Description = table.Column<string>(type: "TEXT", maxLength: 500, nullable: true),
                    ProjectId = table.Column<string>(type: "TEXT", maxLength: 100, nullable: true),
                    ProjectName = table.Column<string>(type: "TEXT", maxLength: 200, nullable: true),
                    ComposePath = table.Column<string>(type: "TEXT", maxLength: 500, nullable: true),
                    EnvironmentId = table.Column<string>(type: "TEXT", maxLength: 100, nullable: true),
                    EnvironmentName = table.Column<string>(type: "TEXT", maxLength: 200, nullable: true),
                    CreatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    UpdatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    LiveRevision = table.Column<int>(type: "INTEGER", nullable: true),
                    LastRevision = table.Column<int>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Stacks", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "StackRevisions",
                columns: table => new
                {
                    StackId = table.Column<Guid>(type: "TEXT", nullable: false),
                    Number = table.Column<int>(type: "INTEGER", nullable: false),
                    State = table.Column<string>(type: "TEXT", maxLength: 30, nullable: false),
                    CreatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    CreatedBy = table.Column<string>(type: "TEXT", maxLength: 256, nullable: true),
                    ComposeSha256 = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    EnvKeys = table.Column<string>(type: "TEXT", nullable: false),
                    Services = table.Column<string>(type: "TEXT", nullable: false),
                    ProxiedServices = table.Column<string>(type: "TEXT", nullable: false),
                    Findings = table.Column<string>(type: "TEXT", nullable: false),
                    AcknowledgedRisks = table.Column<string>(type: "TEXT", nullable: false),
                    Bindings = table.Column<string>(type: "TEXT", nullable: false),
                    Steps = table.Column<string>(type: "TEXT", nullable: false),
                    Builds = table.Column<bool>(type: "INTEGER", nullable: false),
                    HasBuildContext = table.Column<bool>(type: "INTEGER", nullable: false),
                    JobId = table.Column<Guid>(type: "TEXT", nullable: true),
                    DeployedAt = table.Column<long>(type: "INTEGER", nullable: true),
                    FinishedAt = table.Column<long>(type: "INTEGER", nullable: true),
                    RollbackOf = table.Column<int>(type: "INTEGER", nullable: true),
                    Error = table.Column<string>(type: "TEXT", maxLength: 2000, nullable: true),
                    ProjectId = table.Column<string>(type: "TEXT", maxLength: 100, nullable: true),
                    ProjectName = table.Column<string>(type: "TEXT", maxLength: 200, nullable: true),
                    ComposePath = table.Column<string>(type: "TEXT", maxLength: 500, nullable: true),
                    EnvironmentId = table.Column<string>(type: "TEXT", maxLength: 100, nullable: true),
                    EnvironmentName = table.Column<string>(type: "TEXT", maxLength: 200, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_StackRevisions", x => new { x.StackId, x.Number });
                    table.ForeignKey(
                        name: "FK_StackRevisions_Stacks_StackId",
                        column: x => x.StackId,
                        principalTable: "Stacks",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_StackRevisions_State",
                table: "StackRevisions",
                column: "State");

            migrationBuilder.CreateIndex(
                name: "IX_Stacks_Name",
                table: "Stacks",
                column: "Name",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "StackRevisions");

            migrationBuilder.DropTable(
                name: "Stacks");
        }
    }
}
