> ## Documentation Index
> Fetch the complete documentation index at: https://docs.kan.bn/llms.txt
> Use this file to discover all available pages before exploring further.

# Get all workspaces

> Retrieves all workspaces for the authenticated user



## OpenAPI

````yaml https://kan.bn/api/v1/openapi.json get /workspaces
openapi: 3.0.3
info:
  title: Kan API
  description: OpenAPI compliant REST API
  version: 1.0.0
servers:
  - url: https://kan.bn/api/v1
security: []
tags:
  - name: Auth
  - name: Users
  - name: Boards
  - name: Lists
  - name: Cards
  - name: Labels
  - name: Imports
  - name: Integrations
  - name: Health
externalDocs:
  url: docs.kan.bn
paths:
  /workspaces:
    get:
      tags:
        - Workspaces
      summary: Get all workspaces
      description: Retrieves all workspaces for the authenticated user
      operationId: workspace-all
      responses:
        '200':
          description: Successful response
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    role:
                      type: string
                    workspace:
                      type: object
                      properties:
                        publicId:
                          type: string
                        name:
                          type: string
                        description:
                          type: string
                          nullable: true
                        slug:
                          type: string
                        plan:
                          type: string
                          enum:
                            - free
                            - team
                            - pro
                            - enterprise
                        weekStartDay:
                          type: number
                          nullable: true
                        cardPrefix:
                          type: string
                        deletedAt:
                          type: string
                          nullable: true
                      required:
                        - publicId
                        - name
                        - description
                        - slug
                        - plan
                        - weekStartDay
                        - cardPrefix
                        - deletedAt
                  required:
                    - role
                    - workspace
        '401':
          description: Authorization not provided
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/error.UNAUTHORIZED'
        '403':
          description: Insufficient access
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/error.FORBIDDEN'
        '500':
          description: Internal server error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/error.INTERNAL_SERVER_ERROR'
      security:
        - Authorization: []
components:
  schemas:
    error.UNAUTHORIZED:
      type: object
      properties:
        message:
          type: string
          description: The error message
          example: Authorization not provided
        code:
          type: string
          description: The error code
          example: UNAUTHORIZED
        issues:
          type: array
          items:
            type: object
            properties:
              message:
                type: string
            required:
              - message
          description: An array of issues that were responsible for the error
          example: []
      required:
        - message
        - code
      title: Authorization not provided error (401)
      description: The error information
      example:
        code: UNAUTHORIZED
        message: Authorization not provided
        issues: []
    error.FORBIDDEN:
      type: object
      properties:
        message:
          type: string
          description: The error message
          example: Insufficient access
        code:
          type: string
          description: The error code
          example: FORBIDDEN
        issues:
          type: array
          items:
            type: object
            properties:
              message:
                type: string
            required:
              - message
          description: An array of issues that were responsible for the error
          example: []
      required:
        - message
        - code
      title: Insufficient access error (403)
      description: The error information
      example:
        code: FORBIDDEN
        message: Insufficient access
        issues: []
    error.INTERNAL_SERVER_ERROR:
      type: object
      properties:
        message:
          type: string
          description: The error message
          example: Internal server error
        code:
          type: string
          description: The error code
          example: INTERNAL_SERVER_ERROR
        issues:
          type: array
          items:
            type: object
            properties:
              message:
                type: string
            required:
              - message
          description: An array of issues that were responsible for the error
          example: []
      required:
        - message
        - code
      title: Internal server error error (500)
      description: The error information
      example:
        code: INTERNAL_SERVER_ERROR
        message: Internal server error
        issues: []
  securitySchemes:
    Authorization:
      type: http
      scheme: bearer

````