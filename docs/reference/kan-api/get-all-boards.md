> ## Documentation Index
> Fetch the complete documentation index at: https://docs.kan.bn/llms.txt
> Use this file to discover all available pages before exploring further.

# Get all boards

> Retrieves all boards for a given workspace



## OpenAPI

````yaml https://kan.bn/api/v1/openapi.json get /workspaces/{workspacePublicId}/boards
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
  /workspaces/{workspacePublicId}/boards:
    get:
      tags:
        - Boards
      summary: Get all boards
      description: Retrieves all boards for a given workspace
      operationId: board-all
      parameters:
        - in: path
          name: workspacePublicId
          schema:
            type: string
            minLength: 12
          required: true
        - in: query
          name: type
          schema:
            type: string
            enum:
              - regular
              - template
        - in: query
          name: archived
          schema:
            type: boolean
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
                    publicId:
                      type: string
                    name:
                      type: string
                    favorite:
                      type: boolean
                    lists:
                      type: array
                      items:
                        type: object
                        properties:
                          publicId:
                            type: string
                          name:
                            type: string
                          index:
                            type: number
                        required:
                          - publicId
                          - name
                          - index
                    labels:
                      type: array
                      items:
                        type: object
                        properties:
                          publicId:
                            type: string
                          name:
                            type: string
                          colourCode:
                            type: string
                            nullable: true
                        required:
                          - publicId
                          - name
                          - colourCode
                  required:
                    - publicId
                    - name
                    - favorite
                    - lists
                    - labels
        '400':
          description: Invalid input data
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/error.BAD_REQUEST'
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
        '404':
          description: Not found
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/error.NOT_FOUND'
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
    error.BAD_REQUEST:
      type: object
      properties:
        message:
          type: string
          description: The error message
          example: Invalid input data
        code:
          type: string
          description: The error code
          example: BAD_REQUEST
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
      title: Invalid input data error (400)
      description: The error information
      example:
        code: BAD_REQUEST
        message: Invalid input data
        issues: []
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
    error.NOT_FOUND:
      type: object
      properties:
        message:
          type: string
          description: The error message
          example: Not found
        code:
          type: string
          description: The error code
          example: NOT_FOUND
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
      title: Not found error (404)
      description: The error information
      example:
        code: NOT_FOUND
        message: Not found
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