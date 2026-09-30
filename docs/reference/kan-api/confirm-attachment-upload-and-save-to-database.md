> ## Documentation Index
> Fetch the complete documentation index at: https://docs.kan.bn/llms.txt
> Use this file to discover all available pages before exploring further.

# Confirm attachment upload and save to database

> Confirms an attachment upload and saves the record to the database



## OpenAPI

````yaml https://kan.bn/api/v1/openapi.json post /cards/{cardPublicId}/attachments/confirm
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
  /cards/{cardPublicId}/attachments/confirm:
    post:
      tags:
        - Attachments
      summary: Confirm attachment upload and save to database
      description: Confirms an attachment upload and saves the record to the database
      operationId: attachment-confirm
      parameters:
        - in: path
          name: cardPublicId
          schema:
            type: string
            minLength: 12
          required: true
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                s3Key:
                  type: string
                filename:
                  type: string
                originalFilename:
                  type: string
                contentType:
                  type: string
                size:
                  type: number
                  minimum: 0
                  exclusiveMinimum: true
              required:
                - s3Key
                - filename
                - originalFilename
                - contentType
                - size
      responses:
        '200':
          description: Successful response
          content:
            application/json:
              schema:
                type: object
                properties:
                  publicId:
                    type: string
                  filename:
                    type: string
                  originalFilename:
                    type: string
                  contentType:
                    type: string
                  size:
                    type: number
                  s3Key:
                    type: string
                  createdAt:
                    type: string
                required:
                  - publicId
                  - filename
                  - originalFilename
                  - contentType
                  - size
                  - s3Key
                  - createdAt
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