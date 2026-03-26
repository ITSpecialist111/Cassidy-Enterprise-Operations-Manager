// ---------------------------------------------------------------------------
// Bicep IaC — Cassidy Enterprise Operations Manager
// ---------------------------------------------------------------------------
// Provisions: App Service Plan, Web App, Storage Account, Application
// Insights + Log Analytics workspace.
//
// Deploy:
//   az deployment group create \
//     --resource-group rg-cassidy-ops-agent \
//     --template-file infra/main.bicep \
//     --parameters location=australiaeast
// ---------------------------------------------------------------------------

targetScope = 'resourceGroup'

// ── Parameters ─────────────────────────────────────────────────────────────

@description('Azure region for all resources')
param location string = 'australiaeast'

@description('Web app name (must be globally unique)')
param webAppName string = 'cassidyopsagent-webapp'

@description('App Service Plan SKU')
@allowed(['B1', 'B2', 'B3', 'S1', 'S2', 'S3', 'P1v3', 'P2v3', 'P3v3'])
param appServicePlanSku string = 'B1'

@description('Storage account name (3-24 lowercase alphanumeric)')
@minLength(3)
@maxLength(24)
param storageAccountName string = 'cassidyschedsa'

@description('Azure OpenAI endpoint URL')
param openAiEndpoint string = ''

@description('Azure OpenAI deployment name')
param openAiDeployment string = 'gpt-5'

@description('Microsoft App (Bot) ID')
param microsoftAppId string = ''

@secure()
@description('Microsoft App Password')
param microsoftAppPassword string = ''

@description('Microsoft App Tenant ID')
param microsoftAppTenantId string = ''

@description('Scheduled endpoint secret')
@secure()
param scheduledSecret string = ''

// ── Log Analytics + Application Insights ───────────────────────────────────

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${webAppName}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${webAppName}-insights'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

// ── Storage Account ────────────────────────────────────────────────────────

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

var tableNames = [
  'CassidyConversations'
  'CassidyLongTermMemory'
  'CassidyUserRegistry'
  'CassidyUserInsights'
  'CassidyAgentRegistry'
  'CassidyWorkQueue'
]

resource tables 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = [
  for tableName in tableNames: {
    parent: tableService
    name: tableName
  }
]

// ── App Service Plan ───────────────────────────────────────────────────────

resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${webAppName}-plan'
  location: location
  kind: 'linux'
  sku: {
    name: appServicePlanSku
  }
  properties: {
    reserved: true // Linux
  }
}

// ── Web App ────────────────────────────────────────────────────────────────

resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: webAppName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      alwaysOn: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      appSettings: [
        { name: 'AZURE_OPENAI_ENDPOINT', value: openAiEndpoint }
        { name: 'AZURE_OPENAI_DEPLOYMENT', value: openAiDeployment }
        { name: 'AZURE_STORAGE_ACCOUNT', value: storageAccount.name }
        { name: 'MicrosoftAppId', value: microsoftAppId }
        { name: 'MicrosoftAppPassword', value: microsoftAppPassword }
        { name: 'MicrosoftAppTenantId', value: microsoftAppTenantId }
        { name: 'SCHEDULED_SECRET', value: scheduledSecret }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~22' }
        { name: 'NODE_ENV', value: 'production' }
      ]
    }
  }
}

// ── Role Assignment: Web App → Storage Table Data Contributor ──────────────

@description('Storage Table Data Contributor role')
var storageTableDataContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'

resource storageRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storageAccount
  name: guid(storageAccount.id, webApp.id, storageTableDataContributorRoleId)
  properties: {
    principalId: webApp.identity.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRoleId)
    principalType: 'ServicePrincipal'
  }
}

// ── Outputs ────────────────────────────────────────────────────────────────

output webAppUrl string = 'https://${webApp.properties.defaultHostName}'
output appInsightsConnectionString string = appInsights.properties.ConnectionString
output storageAccountName string = storageAccount.name
output webAppPrincipalId string = webApp.identity.principalId
